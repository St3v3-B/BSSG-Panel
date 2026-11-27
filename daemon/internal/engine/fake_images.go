package engine

import (
	"context"
	"errors"
	"fmt"
)

func (f *Fake) remoteIDLocked(ref string) string {
	if id, ok := f.remoteIDs[ref]; ok {
		return id
	}
	return "sha256:" + ref
}

// SetRemote laat het "register" voor ref een nieuw image-id aanbieden (simuleert een nieuwe build).
func (f *Fake) SetRemote(ref, id string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.remoteIDs[ref] = id
}

// SetImageEnv zet Config.Env van een image-id.
func (f *Fake) SetImageEnv(id string, env []string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.imageEnvs[id] = env
}

// AddLocalImage voegt een image toe die niet van de daemon is (bv. van de gebruiker).
func (f *Fake) AddLocalImage(ref, id string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.images[ref] = true
	f.localIDs[ref] = id
	f.imageSet[id] = true
}

// HasImage meldt of een image-id lokaal aanwezig is.
func (f *Fake) HasImage(id string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.imageSet[id]
}

// PullCount telt hoe vaak ref met PullImage is opgehaald.
func (f *Fake) PullCount(ref string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, r := range f.PullLog {
		if r == ref {
			n++
		}
	}
	return n
}

func (f *Fake) PullImage(_ context.Context, ref string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.FailPull != nil {
		return "", f.FailPull
	}
	id := f.remoteIDLocked(ref)
	f.images[ref] = true
	f.localIDs[ref] = id
	f.imageSet[id] = true
	f.PullLog = append(f.PullLog, ref)
	return id, nil
}

func (f *Fake) ImageID(_ context.Context, ref string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if id, ok := f.localIDs[ref]; ok {
		return id, nil
	}
	return "", fmt.Errorf("%w: image %s", ErrNotFound, ref)
}

func (f *Fake) ImageEnv(_ context.Context, refOrID string) ([]string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if id, ok := f.localIDs[refOrID]; ok {
		refOrID = id
	}
	if !f.imageSet[refOrID] {
		return nil, fmt.Errorf("%w: image %s", ErrNotFound, refOrID)
	}
	return f.imageEnvs[refOrID], nil
}

func (f *Fake) ImageUsed(_ context.Context, id string) (bool, error) {
	for _, c := range f.All() {
		if c.ImageID == id {
			return true, nil
		}
	}
	return false, nil
}

func (f *Fake) RemoveImage(ctx context.Context, id string) error {
	if used, _ := f.ImageUsed(ctx, id); used {
		return errors.New("image is in use by a container")
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.imageSet[id] {
		return fmt.Errorf("%w: image %s", ErrNotFound, id)
	}
	delete(f.imageSet, id)
	for ref, lid := range f.localIDs {
		if lid == id {
			delete(f.localIDs, ref)
			delete(f.images, ref)
		}
	}
	return nil
}
