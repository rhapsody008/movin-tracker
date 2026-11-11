package entries_test

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/rhapsody008/movin-tracker/internal/entries"
)

func patch(t *testing.T, js string) entries.Patch {
	t.Helper()
	var p entries.Patch
	if err := json.Unmarshal([]byte(js), &p); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestValidation(t *testing.T) {
	long := func(n int) string { return `"` + strings.Repeat("x", n) + `"` }
	cases := []struct {
		name, kind, js string
		ok             bool
	}{
		{"minimal", "", `{"title":"Fluted panels"}`, true},
		{"full idea", "idea", `{"title":"Quartz top","room":"Wet Kitchen","category":"Carpentry","status":"shortlisted","cost":{"estimate":3000,"actual":null},"vendor":"Lim","date":"2026-11-20","time":"14:00","source":"showroom","notes":"white","tags":["Kitchen","kitchen"," top "]}`, true},
		{"empty title", "", `{"title":"   "}`, false},
		{"title 200", "", `{"title":` + long(200) + `}`, true},
		{"title 201", "", `{"title":` + long(201) + `}`, false},
		{"vendor 201", "", `{"title":"a","vendor":` + long(201) + `}`, false},
		{"source 501", "", `{"title":"a","source":` + long(501) + `}`, false},
		{"notes 4000", "", `{"title":"a","notes":` + long(4000) + `}`, true},
		{"notes 4001", "", `{"title":"a","notes":` + long(4001) + `}`, false},
		{"category 41", "", `{"title":"a","category":` + long(41) + `}`, false},
		{"unknown room", "", `{"title":"a","room":"ac ledge"}`, false},
		{"empty room clears", "", `{"title":"a","room":""}`, true},
		{"null room clears", "", `{"title":"a","room":null}`, true},
		{"bad kind", "", `{"title":"a","kind":"wish"}`, false},
		{"task status on idea", "idea", `{"title":"a","status":"doing"}`, false},
		{"plan status on task", "task", `{"title":"a","status":"shortlisted"}`, false},
		{"task status on task", "task", `{"title":"a","status":"doing"}`, true},
		{"kind and status together", "idea", `{"title":"a","kind":"task","status":"doing"}`, true},
		{"bad date", "", `{"title":"a","date":"20/11/2026"}`, false},
		{"impossible date", "", `{"title":"a","date":"2026-02-30"}`, false},
		{"bad time", "", `{"title":"a","date":"2026-11-20","time":"2pm"}`, false},
		{"time 24:00", "", `{"title":"a","date":"2026-11-20","time":"24:00"}`, false},
		{"time without date", "", `{"title":"a","time":"14:00"}`, false},
		{"empty date clears", "", `{"title":"a","date":""}`, true},
		{"negative cost", "", `{"title":"a","cost":{"estimate":-1}}`, false},
		{"cost as string", "", `{"title":"a","cost":{"estimate":"3k"}}`, false},
		{"cost unknown field", "", `{"title":"a","cost":{"quoted":1}}`, false},
		{"cost not object", "", `{"title":"a","cost":3000}`, false},
		{"tags not list", "", `{"title":"a","tags":"kitchen"}`, false},
		{"tag 41", "", `{"title":"a","tags":[` + long(41) + `]}`, false},
		{"unknown field", "", `{"title":"a","colour":"red"}`, false},
		{"archived not bool", "", `{"title":"a","archived":"yes"}`, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			e := entries.NewEntry(c.kind)
			err := patch(t, c.js).Apply(&e)
			var ve *entries.ValidationError
			if c.ok && err != nil {
				t.Fatalf("want ok, got %v", err)
			}
			if !c.ok && !errors.As(err, &ve) {
				t.Fatalf("want ValidationError, got %v", err)
			}
		})
	}
}

func TestNormalisedFields(t *testing.T) {
	e := entries.NewEntry("idea")
	err := patch(t, `{"title":" Quartz top ","room":"  Wet   Kitchen ","category":"Carpentry","tags":["Kitchen","kitchen"," Top  Choice "]}`).Apply(&e)
	if err != nil {
		t.Fatal(err)
	}
	if e.Title != "Quartz top" || *e.Room != "wet kitchen" || e.Category != "carpentry" {
		t.Fatalf("got title=%q room=%q category=%q", e.Title, *e.Room, e.Category)
	}
	if strings.Join(e.Tags, "|") != "kitchen|top choice" {
		t.Fatalf("tags = %v", e.Tags)
	}
}

func TestDefaultsPerKind(t *testing.T) {
	for kind, want := range map[string]string{"": "idea", "idea": "idea", "decision": "idea", "note": "idea", "question": "idea", "task": "todo"} {
		e := entries.NewEntry(kind)
		if e.Status != want {
			t.Errorf("kind %q: status %q, want %q", kind, e.Status, want)
		}
	}
	if entries.NewEntry("").Kind != "note" {
		t.Error("empty kind should default to note")
	}
}

func TestKindChangeRemapsStatus(t *testing.T) {
	cases := []struct{ fromKind, fromStatus, toKind, want string }{
		{"idea", "idea", "task", "todo"},
		{"idea", "shortlisted", "task", "doing"},
		{"decision", "decided", "task", "todo"},
		{"idea", "done", "task", "done"},
		{"task", "todo", "idea", "idea"},
		{"task", "doing", "decision", "shortlisted"},
		{"task", "done", "note", "done"},
		{"idea", "decided", "decision", "decided"}, // same status set: unchanged
	}
	for _, c := range cases {
		e := entries.NewEntry(c.fromKind)
		e.Title, e.Status = "x", c.fromStatus
		if err := patch(t, `{"kind":"`+c.toKind+`"}`).Apply(&e); err != nil {
			t.Fatalf("%+v: %v", c, err)
		}
		if e.Kind != c.toKind || e.Status != c.want {
			t.Errorf("%s/%s → %s: got %s/%s, want status %s", c.fromKind, c.fromStatus, c.toKind, e.Kind, e.Status, c.want)
		}
	}
}

func TestClearingDateClearsTime(t *testing.T) {
	e := entries.NewEntry("task")
	if err := patch(t, `{"title":"Electrician","date":"2026-11-14","time":"14:00"}`).Apply(&e); err != nil {
		t.Fatal(err)
	}
	if err := patch(t, `{"date":null}`).Apply(&e); err != nil {
		t.Fatal(err)
	}
	if e.Date != nil || e.Time != nil {
		t.Fatalf("date=%v time=%v, want both cleared", e.Date, e.Time)
	}
	// Clearing the date while setting a time in the same patch is refused.
	e2 := entries.NewEntry("task")
	_ = patch(t, `{"title":"x","date":"2026-11-14"}`).Apply(&e2)
	if err := patch(t, `{"date":null,"time":"10:00"}`).Apply(&e2); err == nil {
		t.Fatal("want error for time without date")
	}
}

func TestCostPartialPatch(t *testing.T) {
	e := entries.NewEntry("task")
	_ = patch(t, `{"title":"Carpentry","cost":{"estimate":18000}}`).Apply(&e)
	if err := patch(t, `{"cost":{"actual":5400}}`).Apply(&e); err != nil {
		t.Fatal(err)
	}
	if *e.Cost.Estimate != 18000 || *e.Cost.Actual != 5400 {
		t.Fatalf("cost = %+v", e.Cost)
	}
	_ = patch(t, `{"cost":{"estimate":null}}`).Apply(&e)
	if e.Cost.Estimate != nil || e.Cost.Actual == nil {
		t.Fatalf("cost after clearing estimate = %+v", e.Cost)
	}
	_ = patch(t, `{"cost":null}`).Apply(&e)
	if e.Cost.Estimate != nil || e.Cost.Actual != nil {
		t.Fatalf("cost after null = %+v", e.Cost)
	}
}

func TestDecodeNormalises(t *testing.T) {
	d, err := entries.Decode([]byte(`{"entries":[
		{"id":"1","title":"a","kind":"wish","status":"weird","room":"AC Ledge","date":"bad","time":"10:00","tags":["X","x"],"channel":"fax"},
		{"id":"2","title":"b","kind":"task","status":"shortlisted","room":"Master Bedroom","date":"2026-11-20","time":"9am"}
	]}`))
	if err != nil {
		t.Fatal(err)
	}
	if d.Schema != 1 || d.Changes == nil {
		t.Fatalf("schema=%d changes=%v", d.Schema, d.Changes)
	}
	a, b := d.Entries[0], d.Entries[1]
	if a.Kind != "note" || a.Status != "idea" || a.Room != nil || a.Date != nil || a.Time != nil || len(a.Tags) != 1 || a.Channel != "web" {
		t.Fatalf("entry 1 not normalised: %+v", a)
	}
	if b.Status != "doing" || *b.Room != "master bedroom" || *b.Date != "2026-11-20" || b.Time != nil {
		t.Fatalf("entry 2 not normalised: %+v", b)
	}
	if _, err := entries.Decode([]byte(`{not json`)); err == nil {
		t.Fatal("want decode error")
	}
}

func TestCloneIsDeep(t *testing.T) {
	d := entries.Empty()
	e := entries.NewEntry("idea")
	_ = patch(t, `{"title":"a","room":"flex","date":"2026-11-20","cost":{"estimate":1},"tags":["t"]}`).Apply(&e)
	d.Entries = append(d.Entries, e)
	d.Changes = append(d.Changes, entries.Change{ID: "c1", After: &e})

	c := d.Clone()
	*c.Entries[0].Room = "dining"
	*c.Entries[0].Cost.Estimate = 99
	c.Entries[0].Tags[0] = "changed"
	c.Changes[0].After.Title = "changed"

	if *d.Entries[0].Room != "flex" || *d.Entries[0].Cost.Estimate != 1 || d.Entries[0].Tags[0] != "t" || d.Changes[0].After.Title != "a" {
		t.Fatal("clone shares memory with the original")
	}
}

func TestMetaPatch(t *testing.T) {
	m := entries.Meta{}
	move, bad, empty := "2026-12-05", "05/12/2026", ""
	if err := (entries.MetaPatch{MoveDate: &move, SetMove: true}).Apply(&m); err != nil || *m.MoveDate != move {
		t.Fatalf("set: %v %v", err, m.MoveDate)
	}
	if err := (entries.MetaPatch{KeyDate: &bad, SetKey: true}).Apply(&m); err == nil {
		t.Fatal("want error for bad key date")
	}
	if err := (entries.MetaPatch{MoveDate: &empty, SetMove: true}).Apply(&m); err != nil || m.MoveDate != nil {
		t.Fatalf("clear: %v %v", err, m.MoveDate)
	}
}
