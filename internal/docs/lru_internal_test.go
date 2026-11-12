package docs

import "testing"

func TestByteLRU(t *testing.T) {
	var c byteLRU
	put := func(k string, n int) { c.put(k, make([]byte, n), 3, 100) }
	put("a", 40)
	put("b", 40)
	if _, ok := c.get("a"); !ok { // a is now the most recent
		t.Fatal("a missing")
	}
	put("c", 40) // 120 > 100: the oldest (b) goes
	if _, ok := c.get("b"); ok || c.bytes != 80 {
		t.Fatalf("byte budget: b kept, bytes %d", c.bytes)
	}
	put("d", 10)
	put("e", 10) // 4 entries > 3: the oldest (a) goes
	if _, ok := c.get("a"); ok || len(c.keys) != 3 {
		t.Fatalf("entry cap: %v", c.keys)
	}
	put("huge", 101) // bigger than the whole budget: not cached, nothing evicted
	if _, ok := c.get("huge"); ok || len(c.keys) != 3 {
		t.Fatalf("oversized entry: %v", c.keys)
	}
	put("d", 30) // replacing an entry keeps the byte count right
	if c.bytes != 40+30+10 {
		t.Fatalf("bytes after replace %d", c.bytes)
	}
}
