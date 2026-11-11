package main

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/rhapsody008/movin-tracker/internal/agent"
	"github.com/rhapsody008/movin-tracker/internal/entries"
)

// docCases ask about ZY's real documents (read from the bucket, never
// synced or changed). Each must answer from the documents, change no
// entries, and use the document tools (checked from the tool-call log).
func docCases() []evalCase {
	answer := func(re string, tools ...string) check {
		rx := regexp.MustCompile("(?is)" + re)
		return func(b, a *entries.Doc, res agent.Result) error {
			if err := unchanged(b, a); err != nil {
				return err
			}
			if !rx.MatchString(res.Reply) {
				return fmt.Errorf("reply doesn't match /%s/", re)
			}
			for _, t := range tools {
				if !strings.Contains(lastLog, `"tool":"`+t+`"`) {
					return fmt.Errorf("didn't call %s", t)
				}
			}
			return nil
		}
	}
	return []evalCase{
		// A fact from a manual's text.
		{msg: "How do I defrost the SMEG fridge freezer?", check: answer(`automatic|no.?frost|frost.?free`, "search_documents")},
		// The layout drawing's room names (text layer or a view).
		{msg: "Which rooms are on our unit layout plan?", check: answer(`master bedroom.*balcony|balcony.*master bedroom`)},
		// A location on a drawing: needs the image.
		{msg: "Where is the DB (distribution board) in our unit, according to the power points plan?", check: answer(`kitchen|entrance|main door|front door`, "view_document_page")},
		// A legend term.
		{msg: "On the power points plan, what does WP next to a socket mean?", check: answer(`weather`)},
		// Not on the sheet: it must say so, not invent a number.
		{msg: "How wide is the master bedroom, in metres, according to the layout plan?", check: func(b, a *entries.Doc, res agent.Result) error {
			if err := unchanged(b, a); err != nil {
				return err
			}
			if regexp.MustCompile(`\d+(\.\d+)?\s*(m\b|metre|meter)`).MatchString(res.Reply) && !regexp.MustCompile(`(?i)not|no dimension|doesn't|does not|isn't|scale`).MatchString(res.Reply) {
				return fmt.Errorf("gave a width the plan doesn't state")
			}
			if !regexp.MustCompile(`(?i)(no|not|doesn't|does not|isn't).{0,40}(dimension|measure|width|shown|stated|marked|given)|measure on site|scale`).MatchString(res.Reply) {
				return fmt.Errorf("didn't say the plan has no dimensions")
			}
			return nil
		}},
	}
}
