package engine

import (
	"context"
	"encoding/json"
	"errors"
	"io"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/filters"
	"github.com/docker/docker/api/types/image"
)

// Images is het deel van Engine voor image-updates.
type Images interface {
	// PullImage haalt ref altijd op (ook als hij lokaal staat) en geeft het lokale image-id daarna.
	PullImage(ctx context.Context, ref string) (string, error)
	// ImageID geeft het lokale image-id van ref; ErrNotFound als hij ontbreekt.
	ImageID(ctx context.Context, ref string) (string, error)
	// ImageEnv geeft Config.Env ("K=V") van een image (ref of id).
	ImageEnv(ctx context.Context, refOrID string) ([]string, error)
	// ImageUsed meldt of een container (van wie dan ook, ook gestopt) dit image-id gebruikt.
	ImageUsed(ctx context.Context, id string) (bool, error)
	// RemoveImage verwijdert een image-id zonder force; mislukt als hij nog gebruikt of
	// met meerdere tags verwezen wordt.
	RemoveImage(ctx context.Context, id string) error
}

func (d *Docker) PullImage(ctx context.Context, ref string) (string, error) {
	rc, err := d.cli.ImagePull(ctx, ref, image.PullOptions{})
	if err != nil {
		return "", err
	}
	defer rc.Close()
	dec := json.NewDecoder(rc)
	for {
		var m struct {
			Error string `json:"error"`
		}
		if err := dec.Decode(&m); err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			return "", err
		}
		if m.Error != "" {
			return "", errors.New(m.Error)
		}
	}
	return d.ImageID(ctx, ref)
}

func (d *Docker) ImageID(ctx context.Context, ref string) (string, error) {
	r, err := d.cli.ImageInspect(ctx, ref)
	if err != nil {
		return "", wrap(err)
	}
	return r.ID, nil
}

func (d *Docker) ImageEnv(ctx context.Context, refOrID string) ([]string, error) {
	r, err := d.cli.ImageInspect(ctx, refOrID)
	if err != nil {
		return nil, wrap(err)
	}
	if r.Config == nil {
		return nil, nil
	}
	return r.Config.Env, nil
}

func (d *Docker) ImageUsed(ctx context.Context, id string) (bool, error) {
	list, err := d.cli.ContainerList(ctx, container.ListOptions{All: true, Filters: filters.NewArgs(filters.Arg("ancestor", id))})
	if err != nil {
		return false, err
	}
	return len(list) > 0, nil
}

func (d *Docker) RemoveImage(ctx context.Context, id string) error {
	_, err := d.cli.ImageRemove(ctx, id, image.RemoveOptions{Force: false, PruneChildren: false})
	return wrap(err)
}
