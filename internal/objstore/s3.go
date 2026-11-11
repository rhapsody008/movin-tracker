package objstore

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/aws/smithy-go"
	smithyhttp "github.com/aws/smithy-go/transport/http"
)

// S3 is a Store backed by one bucket and key prefix.
type S3 struct {
	Client *s3.Client
	Bucket string
	Prefix string
}

// S3Options configures NewS3. Credentials come from the default AWS chain
// (env vars, IRSA, instance profile), so none are passed here.
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
	return &S3{Client: client, Bucket: o.Bucket, Prefix: o.Prefix}, nil
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

func (s *S3) Head(ctx context.Context, key string) (string, error) {
	out, err := s.Client.HeadObject(ctx, &s3.HeadObjectInput{Bucket: &s.Bucket, Key: aws.String(s.key(key))})
	if err != nil {
		return "", mapErr(err)
	}
	return aws.ToString(out.ETag), nil
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

// CreateBucket makes the bucket and turns versioning on. Local dev only; the
// production IAM policy deliberately does not allow it.
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
