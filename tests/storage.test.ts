import assert from "node:assert/strict";
import test from "node:test";
import { useTestDatabase } from "./helpers/db.ts";

process.env.APP_BASE_URL = "https://zinstaposter.vercel.app";
delete process.env.BLOB_READ_WRITE_TOKEN;

await useTestDatabase();

const { getObject, isPubliclyFetchable, putObject, storageDriver } = await import(
  "@/lib/storage"
);
const { assertPublishable } = await import("@/lib/instagram/publish");

/**
 * Instagram fetches slide images itself, from a public https URL, with no
 * credentials. Without an object store the app is its own image host, so what
 * matters is that the bytes survive the round trip and that the URL is one
 * Meta can actually reach.
 */

test("the database is the store when no Blob token is configured", () => {
  assert.equal(storageDriver(), "database");
});

test("a stored JPEG comes back byte-identical", async () => {
  // A minimal but real JPEG: SOI, a comment segment, EOI.
  const original = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xfe, 0x00, 0x10]),
    Buffer.from("not a real image"),
    Buffer.from([0xff, 0xd9]),
  ]);

  const stored = await putObject("posts/abc/slides/1.jpg", original, "image/jpeg");
  assert.equal(stored.bytes, original.byteLength);
  assert.equal(stored.pathname, "posts/abc/slides/1.jpg");

  const read = await getObject("posts/abc/slides/1.jpg");
  assert.ok(read, "the object is retrievable");
  assert.equal(read.contentType, "image/jpeg");
  assert.deepEqual(
    [...read.body],
    [...original],
    "every byte survives the round trip",
  );
});

test("re-rendering a slide replaces it rather than failing on the key", async () => {
  const first = Buffer.from([0xff, 0xd8, 0x01, 0xff, 0xd9]);
  const second = Buffer.from([0xff, 0xd8, 0x02, 0x02, 0x02, 0xff, 0xd9]);

  await putObject("posts/abc/slides/2.jpg", first, "image/jpeg");
  await putObject("posts/abc/slides/2.jpg", second, "image/jpeg");

  const read = await getObject("posts/abc/slides/2.jpg");
  assert.deepEqual([...(read?.body ?? [])], [...second]);
  assert.equal(read?.body.byteLength, second.byteLength);
});

test("a missing object is absent rather than an error", async () => {
  assert.equal(await getObject("posts/nope/slides/9.jpg"), undefined);
});

test("a leading slash does not create a second, unreachable copy", async () => {
  const bytes = Buffer.from([0xff, 0xd8, 0x03, 0xff, 0xd9]);
  const stored = await putObject("/posts/abc/slides/3.jpg", bytes, "image/jpeg");
  assert.equal(stored.pathname, "posts/abc/slides/3.jpg");
  assert.ok(await getObject("posts/abc/slides/3.jpg"));
  assert.ok(await getObject("/posts/abc/slides/3.jpg"));
});

test("the URL it hands back is one Instagram can fetch", async () => {
  const stored = await putObject(
    "posts/abc/slides/4.jpg",
    Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    "image/jpeg",
  );
  assert.equal(
    stored.url,
    "https://zinstaposter.vercel.app/api/media/posts/abc/slides/4.jpg",
  );
  assert.ok(isPubliclyFetchable(stored.url));

  // And the publish preflight accepts a carousel built from URLs like it.
  assert.doesNotThrow(() =>
    assertPublishable({
      post: { status: "approved", caption: "ok", approvedBy: "a person" },
      slides: [1, 2, 3, 4].map((position) => ({
        position,
        renderedUrl: `https://zinstaposter.vercel.app/api/media/posts/abc/slides/${position}.jpg`,
        altText: "alt",
        width: 1080,
        height: 1350,
      })),
    }),
  );
});

test("a localhost origin is caught before a container is ever created", () => {
  assert.equal(
    isPubliclyFetchable("http://localhost:3000/api/media/posts/a/1.jpg"),
    false,
  );
  assert.throws(
    () =>
      assertPublishable({
        post: { status: "approved", caption: "ok", approvedBy: "a person" },
        slides: [1, 2].map((position) => ({
          position,
          renderedUrl: `http://localhost:3000/api/media/${position}.jpg`,
          altText: "alt",
          width: 1080,
          height: 1350,
        })),
      }),
    /public https URLs/,
  );
});
