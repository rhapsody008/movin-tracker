package telegram

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/rhapsody008/movin-tracker/internal/objstore"
	"github.com/rhapsody008/movin-tracker/internal/sched"
)

// CheckinKey holds the record of the last morning check-in, so it is sent
// at most once a day by whichever copy of the app (dev or production) gets
// there first, and survives restarts. Deleting it means "not sent today".
const CheckinKey = "checkin.json"

// Check-in record statuses.
const (
	CheckinSending = "sending" // claimed; messages going out
	CheckinSent    = "sent"
	CheckinQuiet   = "quiet" // nothing to report that day; nothing sent
)

// CheckinCutoff is the local hour after which a missed check-in is skipped
// for the day rather than sent late; config refuses a schedule at or after
// it.
const CheckinCutoff = 20

// StaleClaim is how long a "sending" claim holds; after that (a crash
// mid-send) another run may take the day over.
const StaleClaim = 10 * time.Minute

// CheckinRecord is checkin.json.
type CheckinRecord struct {
	Schema int    `json:"schema"`
	Day    string `json:"day"` // YYYY-MM-DD in the app's TZ
	Status string `json:"status"`
	At     string `json:"at"`             // RFC 3339, when the status was set
	Chat   string `json:"chat,omitempty"` // where it went
}

// CheckinStore reads and claims the record with conditional writes.
type CheckinStore struct {
	Store objstore.Store
	Now   func() time.Time
}

// Load returns the record and its ETag ("" and a zero record when there is
// none yet).
func (s *CheckinStore) Load(ctx context.Context) (CheckinRecord, string, error) {
	body, etag, err := s.Store.Get(ctx, CheckinKey)
	if errors.Is(err, objstore.ErrNotFound) {
		return CheckinRecord{}, "", nil
	}
	if err != nil {
		return CheckinRecord{}, "", err
	}
	var r CheckinRecord
	if err := json.Unmarshal(body, &r); err != nil {
		return CheckinRecord{}, "", fmt.Errorf("decode %s: %w", CheckinKey, err)
	}
	return r, etag, nil
}

// Done reports whether day is already handled (sent, quiet, or being sent
// by someone else within StaleClaim).
func (r CheckinRecord) Done(day string, now time.Time) bool {
	if r.Day != day {
		return false
	}
	if r.Status != CheckinSending {
		return true
	}
	at, err := time.Parse(time.RFC3339, r.At)
	return err == nil && now.Sub(at) < StaleClaim
}

// Since is the first day the next check-in should ask about: the day after
// the last one that went out (or was quiet); the same day again if that
// one may not have finished; "" when there was none.
func (r CheckinRecord) Since() string {
	switch {
	case r.Day == "":
		return ""
	case r.Status == CheckinSending:
		return r.Day
	default:
		return sched.AddDays(r.Day, 1)
	}
}

// Claim takes day for this run. It returns ok=false when the day is
// already handled or another run won the conditional write. prev is the
// record it replaced (for Since and for Release); etag is the claim's.
func (s *CheckinStore) Claim(ctx context.Context, day, chat string) (prev CheckinRecord, etag string, ok bool, err error) {
	prev, prevTag, err := s.Load(ctx)
	if err != nil {
		return prev, "", false, err
	}
	if prev.Done(day, s.Now()) {
		return prev, "", false, nil
	}
	etag, err = s.put(ctx, CheckinRecord{Day: day, Status: CheckinSending, At: s.stamp(), Chat: chat}, prevTag)
	if errors.Is(err, objstore.ErrPrecondition) {
		return prev, "", false, nil
	}
	if err != nil {
		return prev, "", false, err
	}
	return prev, etag, true, nil
}

// Finish marks the claimed day sent or quiet.
func (s *CheckinStore) Finish(ctx context.Context, etag string, r CheckinRecord, status string) error {
	r.Status, r.At = status, s.stamp()
	_, err := s.put(ctx, r, etag)
	return err
}

// Release gives a claimed day back after a failed send, restoring the
// previous record as it was (its time too, so a stale claim stays stale)
// and the next try asks about the same days.
func (s *CheckinStore) Release(ctx context.Context, etag string, prev CheckinRecord) error {
	if prev.Day == "" {
		// There was no record: leave an empty one (a conditional delete
		// isn't available), which reads as "never sent".
		prev = CheckinRecord{}
	}
	_, err := s.put(ctx, prev, etag)
	return err
}

func (s *CheckinStore) put(ctx context.Context, r CheckinRecord, ifMatch string) (string, error) {
	r.Schema = 1
	body, err := json.Marshal(r)
	if err != nil {
		return "", err
	}
	return s.Store.Put(ctx, CheckinKey, body, ifMatch)
}

func (s *CheckinStore) stamp() string { return s.Now().UTC().Format(time.RFC3339) }

// CheckinDue reports whether a check-in scheduled at hh:mm should go out
// at now: from that time until CheckinCutoff, local time in loc.
func CheckinDue(now time.Time, hh, mm int, loc *time.Location) bool {
	n := now.In(loc)
	at := time.Date(n.Year(), n.Month(), n.Day(), hh, mm, 0, 0, loc)
	cutoff := time.Date(n.Year(), n.Month(), n.Day(), CheckinCutoff, 0, 0, 0, loc)
	return !n.Before(at) && n.Before(cutoff)
}
