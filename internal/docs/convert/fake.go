package convert

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/rhapsody008/movin-tracker/internal/docs"
)

// Fake is a Converter for tests: it answers from Pages keyed by the PDF's
// bytes, counts calls, and fails for bodies listed in Fail.
type Fake struct {
	mu      sync.Mutex
	Pages   map[string][]docs.Page
	Fail    map[string]error
	Calls   int
	Renders int
	Delay   time.Duration // each Text call sleeps this long (single-flight tests)
}

func (f *Fake) Text(_ context.Context, pdf []byte) ([]docs.Page, error) {
	time.Sleep(f.Delay)
	f.mu.Lock()
	defer f.mu.Unlock()
	f.Calls++
	if err := f.Fail[string(pdf)]; err != nil {
		return nil, err
	}
	p, ok := f.Pages[string(pdf)]
	if !ok {
		return nil, fmt.Errorf("fake: unknown PDF %q", pdf)
	}
	return append([]docs.Page(nil), p...), nil
}

func (f *Fake) Render(_ context.Context, pdf []byte, page int, region *Region, longEdge int) ([]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.Renders++
	p, ok := f.Pages[string(pdf)]
	if !ok {
		return nil, fmt.Errorf("fake: unknown PDF %q", pdf)
	}
	if _, err := checkPage(p, page); err != nil {
		return nil, err
	}
	return []byte(fmt.Sprintf("PNG page=%d region=%v edge=%d", page, region, longEdge)), nil
}

// CallCount returns Calls under the lock.
func (f *Fake) CallCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.Calls
}

var _ Converter = (*Fake)(nil)
