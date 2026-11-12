package entries

import "testing"

// Every patchable field except kind (applied first) has a setter.
func TestEveryPatchableFieldHasASetter(t *testing.T) {
	for k := range patchable {
		if _, ok := setters[k]; !ok && k != "kind" {
			t.Errorf("no setter for %q", k)
		}
	}
	for k := range setters {
		if !patchable[k] {
			t.Errorf("setter for %q, which isn't patchable", k)
		}
	}
}
