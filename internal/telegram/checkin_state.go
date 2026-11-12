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

// StaleClaim is how long a "sending" claim holds; after that (a crash
// mid-send) another run may take the day over.
const StaleClaim = 10 * time.Minute

// CheckinRecord is checkin.json.
type CheckinRecord struct {
	Schema int    `json:"schema"`
	Day    string `json:"day"` // YYYY-MM-DD in the app's TZ
	Status string `json:"status"`
	// Since is the first day this check-in asks about (tasks dated from
	// Since to the day before Day); kept so a run that takes over a crashed
	// claim asks about the same days.
	Since string `json:"since,omitempty"`
	At    string `json:"at"`             // RFC 3339, when the status was set
	Chat  string `json:"chat,omitempty"` // where it went
}

// CheckinStore reads and claims the record with conditional writes.
type CheckinStore struct {
	Store objstore.Store
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

// Finished reports whether day's check-in went out or was quiet.
func (r CheckinRecord) Finished(day string) bool {
	return r.Day == day && (r.Status == CheckinSent || r.Status == CheckinQuiet)
}

// Taken reports whether day is finished or being sent by someone within
// StaleClaim.
func (r CheckinRecord) Taken(day string, now time.Time) bool {
	if r.Finished(day) {
		return true
	}
	if r.Day != day || r.Status != CheckinSending {
		return false
	}
	at, err := time.Parse(time.RFC3339, r.At)
	return err == nil && now.Sub(at) < StaleClaim
}

// NextSince is the first day the next check-in should ask about. A
// check-in on day D listed D's tasks as "today" without asking, so the next
// one asks from D. A claim that may not have finished asks its own days
// again. "" when there was none (the agenda then asks about yesterday).
func (r CheckinRecord) NextSince() string {
	switch {
	case r.Day == "":
		return ""
	case r.Status == CheckinSending && r.Since != "":
		return r.Since
	default:
		return r.Day
	}
}

// CheckinClaim is a day this run has taken.
type CheckinClaim struct {
	Record CheckinRecord // what was written: Day, Since, Chat
	Prev   CheckinRecord // what it replaced (Release puts it back)
	ETag   string
}

// Claim takes day for this run. It returns nil when the day is already
// taken or another run won the conditional write, together with the record
// as read.
func (s *CheckinStore) Claim(ctx context.Context, day, chat string, now time.Time) (*CheckinClaim, CheckinRecord, error) {
	prev, prevTag, err := s.Load(ctx)
	if err != nil {
		return nil, prev, err
	}
	if prev.Taken(day, now) {
		return nil, prev, nil
	}
	rec := CheckinRecord{Day: day, Status: CheckinSending, Since: prev.NextSince(), At: stamp(now), Chat: chat}
	if prev.Day == day && prev.Status == CheckinSending {
		rec.Since = prev.Since // taking over a crashed claim: the same days
	}
	etag, err := s.put(ctx, rec, prevTag)
	if errors.Is(err, objstore.ErrPrecondition) {
		return nil, prev, nil
	}
	if err != nil {
		return nil, prev, err
	}
	return &CheckinClaim{Record: rec, Prev: prev, ETag: etag}, prev, nil
}

// Finish marks the claimed day sent or quiet.
func (s *CheckinStore) Finish(ctx context.Context, c *CheckinClaim, status string, now time.Time) error {
	r := c.Record
	r.Status, r.At = status, stamp(now)
	_, err := s.put(ctx, r, c.ETag)
	return err
}

// Release gives a claimed day back after a failed send, restoring the
// previous record as it was (its time too, so a stale claim stays stale),
// so the next try asks about the same days.
func (s *CheckinStore) Release(ctx context.Context, c *CheckinClaim) error {
	// With no previous record this writes an empty one (a conditional
	// delete isn't available), which reads as "never sent".
	_, err := s.put(ctx, c.Prev, c.ETag)
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

func stamp(t time.Time) string { return t.UTC().Format(time.RFC3339) }

// CheckinDue reports whether a check-in scheduled at hh:mm should go out
// at now: from that time until sched.CheckinCutoff, local time in loc.
func CheckinDue(now time.Time, hh, mm int, loc *time.Location) bool {
	n := now.In(loc)
	at := time.Date(n.Year(), n.Month(), n.Day(), hh, mm, 0, 0, loc)
	cutoff := time.Date(n.Year(), n.Month(), n.Day(), sched.CheckinCutoff, 0, 0, 0, loc)
	return !n.Before(at) && n.Before(cutoff)
}
