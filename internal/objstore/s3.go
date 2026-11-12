package objstore

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/aws/smithy-go"
	smithyhttp "github.com/aws/smithy-go/transport/http"
)

// S3 is a Store backed by one bucket and key prefix.
type S3 struct {
	Client   *s3.Client
	Bucket   string
	Prefix   string
	Region   string
	Endpoint string
	// ListPageSize is the page size for List (0: S3's default of 1000).
	// Tests lower it to exercise pagination.
	ListPageSize int32
	creds        aws.CredentialsProvider
}

// S3Options configures NewS3. Credentials come from the default AWS chain
// (env keys, shared profile, web identity, instance role), so none are
// passed here.
type S3Options struct {
	Bucket      string
	Prefix      string
	Region      string
	EndpointURL string // set for MinIO; enables path-style addressing
}

func NewS3(ctx context.Context, o S3Options) (*S3, error) {
	cfg, err := awsconfig.LoadDefaultConfig(ctx, awsconfig.WithRegion(o.Region))
	if err != nil {
		return nil, fmt.Errorf("load AWS config: %w", err)
	}
	client := s3.NewFromConfig(cfg, func(opt *s3.Options) {
		if o.EndpointURL != "" {
			opt.BaseEndpoint = aws.String(o.EndpointURL)
			opt.UsePathStyle = true
		}
	})
	return &S3{Client: client, Bucket: o.Bucket, Prefix: o.Prefix, Region: o.Region, Endpoint: o.EndpointURL, creds: cfg.Credentials}, nil
}

func (s *S3) key(k string) string {
	if s.Prefix == "" {
		return k
	}
	return s.Prefix + "/" + k
}

func (s *S3) Get(ctx context.Context, key string) ([]byte, string, error) {
	out, err := s.Client.GetObject(ctx, &s3.GetObjectInput{Bucket: &s.Bucket, Key: aws.String(s.key(key))})
	if err != nil {
		return nil, "", mapErr(err)
	}
	defer out.Body.Close()
	body, err := io.ReadAll(out.Body)
	if err != nil {
		return nil, "", err
	}
	return body, aws.ToString(out.ETag), nil
}

func (s *S3) Put(ctx context.Context, key string, body []byte, ifMatch string) (string, error) {
	in := &s3.PutObjectInput{
		Bucket:      &s.Bucket,
		Key:         aws.String(s.key(key)),
		Body:        bytes.NewReader(body),
		ContentType: aws.String("application/json"),
	}
	if ifMatch != "" {
		in.IfMatch = aws.String(ifMatch)
	} else {
		in.IfNoneMatch = aws.String("*")
	}
	out, err := s.Client.PutObject(ctx, in)
	if err != nil {
		return "", mapErr(err)
	}
	return aws.ToString(out.ETag), nil
}

func (s *S3) Stat(ctx context.Context, key string) (ObjectInfo, error) {
	out, err := s.Client.HeadObject(ctx, &s3.HeadObjectInput{Bucket: &s.Bucket, Key: aws.String(s.key(key))})
	if err != nil {
		return ObjectInfo{}, mapErr(err)
	}
	return ObjectInfo{Key: key, ETag: aws.ToString(out.ETag), Size: aws.ToInt64(out.ContentLength), LastModified: aws.ToTime(out.LastModified)}, nil
}

func (s *S3) List(ctx context.Context, prefix string) ([]ObjectInfo, error) {
	in := &s3.ListObjectsV2Input{Bucket: &s.Bucket, Prefix: aws.String(s.key(prefix))}
	if s.ListPageSize > 0 {
		in.MaxKeys = aws.Int32(s.ListPageSize)
	}
	strip := ""
	if s.Prefix != "" {
		strip = s.Prefix + "/"
	}
	out := []ObjectInfo{}
	for p := s3.NewListObjectsV2Paginator(s.Client, in); p.HasMorePages(); {
		page, err := p.NextPage(ctx)
		if err != nil {
			return nil, mapErr(err)
		}
		for _, o := range page.Contents {
			out = append(out, ObjectInfo{
				Key: strings.TrimPrefix(aws.ToString(o.Key), strip), ETag: aws.ToString(o.ETag),
				Size: aws.ToInt64(o.Size), LastModified: aws.ToTime(o.LastModified),
			})
		}
	}
	return out, nil // S3 lists in key (UTF-8 byte) order
}

func (s *S3) PutBlob(ctx context.Context, key string, body []byte, contentType string) (string, error) {
	out, err := s.Client.PutObject(ctx, &s3.PutObjectInput{
		Bucket: &s.Bucket, Key: aws.String(s.key(key)), Body: bytes.NewReader(body), ContentType: aws.String(contentType),
	})
	if err != nil {
		return "", mapErr(err)
	}
	return aws.ToString(out.ETag), nil
}

func (s *S3) Delete(ctx context.Context, key string) error {
	_, err := s.Client.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: &s.Bucket, Key: aws.String(s.key(key))})
	return mapErr(err)
}

// Info reports where the store points and which kind of credentials the
// AWS chain found. It resolves the credentials (cached by the SDK) but only
// keeps their source name.
func (s *S3) Info(ctx context.Context) Info {
	in := Info{Backend: "s3", Bucket: s.Bucket, Region: s.Region, Prefix: s.Prefix, Endpoint: s.Endpoint}
	if s.creds == nil {
		in.CredentialSource = "none"
		return in
	}
	c, err := s.creds.Retrieve(ctx)
	if err != nil {
		in.CredentialSource = "none found"
		in.CredentialError = "no AWS credentials could be loaded"
		return in
	}
	in.CredentialSource = CredentialLabel(c.Source)
	return in
}

// CredentialLabel turns an AWS SDK credential source name into a short
// label for the admin page.
func CredentialLabel(source string) string {
	switch {
	case strings.Contains(source, "EnvConfig"):
		return "env keys"
	case strings.Contains(source, "WebIdentity"):
		return "web identity (IRSA)"
	case strings.Contains(source, "SharedConfig"):
		return "shared profile"
	case strings.Contains(source, "EC2RoleProvider"):
		return "instance role"
	case strings.Contains(source, "Endpoint"), strings.Contains(source, "ECS"):
		return "container role"
	case strings.Contains(source, "SSO"):
		return "SSO"
	case source == "":
		return "unknown"
	}
	return source
}

// CreateBucket makes the bucket and turns versioning on. Tests (MinIO) only.
func (s *S3) CreateBucket(ctx context.Context) error {
	_, err := s.Client.CreateBucket(ctx, &s3.CreateBucketInput{Bucket: &s.Bucket})
	var owned *types.BucketAlreadyOwnedByYou
	var exists *types.BucketAlreadyExists
	if err != nil && !errors.As(err, &owned) && !errors.As(err, &exists) {
		return err
	}
	_, err = s.Client.PutBucketVersioning(ctx, &s3.PutBucketVersioningInput{
		Bucket:                  &s.Bucket,
		VersioningConfiguration: &types.VersioningConfiguration{Status: types.BucketVersioningStatusEnabled},
	})
	return err
}

func mapErr(err error) error {
	if err == nil {
		return nil
	}
	var re *smithyhttp.ResponseError
	if errors.As(err, &re) {
		switch re.HTTPStatusCode() {
		case http.StatusNotFound:
			return ErrNotFound
		case http.StatusPreconditionFailed:
			return ErrPrecondition
		case http.StatusConflict:
			// S3 answers 409 ConditionalRequestConflict when two conditional
			// writes race on the same key; the caller should re-read and retry.
			return ErrPrecondition
		}
	}
	var ae smithy.APIError
	if errors.As(err, &ae) {
		switch ae.ErrorCode() {
		case "NoSuchKey", "NotFound":
			return ErrNotFound
		case "PreconditionFailed", "ConditionalRequestConflict":
			return ErrPrecondition
		}
	}
	return err
}
