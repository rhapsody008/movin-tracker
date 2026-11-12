package agent_test

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/rhapsody008/movin-tracker/internal/agent"
	"github.com/rhapsody008/movin-tracker/internal/entries"
)

// fixClock makes the entries service stamp the same day the runner sees.
func fixClock(r *rig) {
	r.svc.SetClock(r.runner.Now)
	r.svc.SetLocation(r.runner.Loc)
}

func TestMilestonesThroughTheTools(t *testing.T) {
	r := newRig(t)
	fixClock(r)
	ctx := context.Background()
	res, _ := r.svc.Create(ctx, entries.Actor{By: "zy", Channel: "web"}, []entries.Patch{mustPatch(t, `{"kind":"task","title":"Hack walls"}`)})
	id := res.Entries[0].ID

	r.llm.steps = []step{
		{calls: [][2]string{
			{"add_entry", `{"entries":[{"kind":"note","title":"Keys collected","status":"done","milestone":true}]}`},
			{"update_entry", fmt.Sprintf(`{"id":%q,"status":"done","milestone":true}`, id)},
		}},
		{calls: [][2]string{{"search_entries", `{"milestone":true}`}}},
		{text: "Two milestones."},
	}
	out := r.run(t, user("zy", "telegram", "we got the keys today, and the walls are hacked: both milestones"))
	want := []string{
		"Saved: note · Keys collected · done Wed, 11 Nov · ★ milestone",
		"Updated: Hack walls (status done, ★ milestone)",
	}
	if len(out.Changes) != 2 || out.Changes[0].Text != want[0] || out.Changes[1].Text != want[1] {
		t.Fatalf("changes %+v", out.Changes)
	}
	// The search returned both milestones, each with its done day.
	got := r.llm.reqs[2]
	last := got[len(got)-1].Content
	if !strings.Contains(last, `"total":2`) || strings.Count(last, `"completed":"2026-11-11"`) != 2 || strings.Count(last, `"milestone":true`) != 2 {
		t.Fatalf("milestone search result: %s", last)
	}
	// The tool schema offers both fields and the filter.
	snap, _ := r.svc.Current(ctx)
	for _, e := range snap.Doc.Entries {
		if !e.IsMilestone() {
			t.Fatalf("not a milestone: %+v", e)
		}
	}
}

func TestMilestoneToolSchema(t *testing.T) {
	var add, upd, search string
	for _, tl := range agent.Tools {
		switch tl.Function.Name {
		case "add_entry":
			add = string(tl.Function.Parameters)
		case "update_entry":
			upd = string(tl.Function.Parameters)
		case "search_entries":
			search = string(tl.Function.Parameters)
		}
	}
	for name, s := range map[string]string{"add_entry": add, "update_entry": upd} {
		if !strings.Contains(s, `"milestone":{"type":"boolean"`) || !strings.Contains(s, `"completed":{"type":"string"`) {
			t.Errorf("%s lacks milestone/completed: %s", name, s)
		}
	}
	if !strings.Contains(search, `"milestone":{"type":"boolean"`) {
		t.Errorf("search_entries lacks the milestone filter")
	}
}

func TestMilestoneOnClaude(t *testing.T) {
	r, cs := claudeRig(t,
		claudeStep{stop: "tool_use", calls: [][2]string{{"add_entry", `{"entries":[{"kind":"note","title":"Keys collected","status":"done","milestone":true}]}`}}},
		claudeStep{stop: "end_turn", text: "Noted the milestone."},
	)
	fixClock(r)
	res := r.run(t, user("ZY", "telegram", "keys collected today, that's a milestone"))
	if len(res.Changes) != 1 || res.Changes[0].Text != "Saved: note · Keys collected · done Wed, 11 Nov · ★ milestone" {
		t.Fatalf("changes %+v", res.Changes)
	}
	if !strings.Contains(string(cs.reqs[0]["tools"]), `"milestone"`) {
		t.Fatalf("Claude tools lack milestone")
	}
}

// Entries without the new fields keep their exact prompt line, so adding
// the fields doesn't rewrite the cached entries section; a done milestone
// carries them at the end of its line.
func TestPromptLinesForMilestones(t *testing.T) {
	r := newRig(t)
	fixClock(r)
	ctx := context.Background()
	a := entries.Actor{By: "zy", Channel: "web"}
	r.svc.Create(ctx, a, []entries.Patch{mustPatch(t, `{"kind":"idea","title":"Fluted panels"}`)})
	r.svc.Create(ctx, a, []entries.Patch{mustPatch(t, `{"kind":"note","title":"Keys collected","status":"done","milestone":true}`)})
	snap, _ := r.svc.Current(ctx)
	secs := r.runner.SystemSections(snap.Doc, agent.Request{})
	ents := secs[1].Text
	if !strings.Contains(ents, `"title":"Fluted panels","status":"idea"}`) {
		t.Fatalf("plain entry line changed: %s", ents)
	}
	if !strings.Contains(ents, `"title":"Keys collected","status":"done","milestone":true,"completed":"2026-11-11"}`) {
		t.Fatalf("milestone line: %s", ents)
	}
	if !strings.Contains(secs[0].Text, "search_entries with milestone=true") {
		t.Fatal("rules lack the milestone line")
	}
}

func TestMilestoneChangeText(t *testing.T) {
	day := "2026-11-10"
	b := entries.Entry{Kind: "task", Title: "Paint", Status: "done", Milestone: true, Completed: &day}
	a := b
	a.Milestone = false
	if got := agent.ChangeText(entries.Change{Op: "update", Before: &b, After: &a}); got != "Updated: Paint (no longer a milestone)" {
		t.Errorf("unflag: %q", got)
	}
	other := "2026-11-08"
	a = b
	a.Completed = &other
	if got := agent.ChangeText(entries.Change{Op: "update", Before: &b, After: &a}); got != "Updated: Paint (done on 2026-11-08)" {
		t.Errorf("day: %q", got)
	}
}
