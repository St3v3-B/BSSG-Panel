// Package backup maakt en herstelt backups: tar.zst van de serverdata, gestreamd naar
// S3 met een SHA-256 tijdens het streamen, plus database-dumps (zie docs/ontwerp.md).
package backup

import (
	"context"
	"fmt"
	"io"
	"net/url"
	"strings"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

// S3 is S3Credentials uit openapi.yaml. De waarden leven alleen zolang het verzoek loopt.
type S3 struct {
	Endpoint  string `json:"endpoint"`
	Bucket    string `json:"bucket"`
	Region    string `json:"region"`
	AccessKey string `json:"access_key"`
	SecretKey string `json:"secret_key"`
	PathStyle bool   `json:"path_style"`
}

// String laat de geheimen nooit in logs terechtkomen.
func (S3) String() string   { return "S3{…}" }
func (S3) GoString() string { return "S3{…}" }

// partSize is de grootte van een multipart-deel (geheugengebruik = één deel).
const partSize = 16 << 20

func (c S3) client() (*minio.Client, error) {
	ep := c.Endpoint
	secure := true
	if !strings.Contains(ep, "://") {
		ep = "https://" + ep
	}
	u, err := url.Parse(ep)
	if err != nil || u.Host == "" {
		return nil, fmt.Errorf("invalid S3 endpoint")
	}
	secure = u.Scheme == "https"
	lookup := minio.BucketLookupDNS
	if c.PathStyle {
		lookup = minio.BucketLookupPath
	}
	return minio.New(u.Host, &minio.Options{
		Creds:        credentials.NewStaticV4(c.AccessKey, c.SecretKey, ""),
		Secure:       secure,
		Region:       c.Region,
		BucketLookup: lookup,
	})
}

// objectStore is wat het backup-pakket van S3 gebruikt.
type objectStore struct {
	cl     *minio.Client
	bucket string
}

func newStore(c S3) (*objectStore, error) {
	cl, err := c.client()
	if err != nil {
		return nil, err
	}
	return &objectStore{cl: cl, bucket: c.Bucket}, nil
}

// put streamt r als multipart-upload (lengte onbekend).
func (o *objectStore) put(ctx context.Context, key string, r io.Reader) (int64, error) {
	info, err := o.cl.PutObject(ctx, o.bucket, key, r, -1, minio.PutObjectOptions{
		PartSize:    partSize,
		NumThreads:  1,
		ContentType: "application/zstd",
	})
	if err != nil {
		return 0, err
	}
	return info.Size, nil
}

// get opent een object en geeft ook de grootte.
func (o *objectStore) get(ctx context.Context, key string) (io.ReadCloser, int64, error) {
	obj, err := o.cl.GetObject(ctx, o.bucket, key, minio.GetObjectOptions{})
	if err != nil {
		return nil, 0, err
	}
	st, err := obj.Stat()
	if err != nil {
		obj.Close()
		return nil, 0, err
	}
	return obj, st.Size, nil
}

func (o *objectStore) remove(ctx context.Context, key string) error {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	return o.cl.RemoveObject(ctx, o.bucket, key, minio.RemoveObjectOptions{})
}
