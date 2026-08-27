const UPLOAD_TOKEN = "webeditor-upload-temp-20260826";

function json(value, init = {}) {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

function requireUploadToken(request) {
  return request.headers.get("x-upload-token") === UPLOAD_TOKEN;
}

export default {
  async fetch(request, env) {
    if (!requireUploadToken(request)) {
      return json({ error: "forbidden" }, { status: 403 });
    }

    const url = new URL(request.url);
    const key = url.searchParams.get("key");
    if (!key) {
      return json({ error: "missing key" }, { status: 400 });
    }

    if (url.pathname === "/init") {
      const upload = await env.BUCKET.createMultipartUpload(key, {
        httpMetadata: {
          cacheControl: "public, max-age=31536000, immutable",
          contentType: "video/mp4",
        },
      });
      return json({ key: upload.key, uploadId: upload.uploadId });
    }

    const uploadId = url.searchParams.get("uploadId");
    if (!uploadId) {
      return json({ error: "missing uploadId" }, { status: 400 });
    }
    const upload = env.BUCKET.resumeMultipartUpload(key, uploadId);

    if (url.pathname === "/part") {
      const partNumber = Number(url.searchParams.get("partNumber"));
      if (!Number.isInteger(partNumber) || partNumber < 1) {
        return json({ error: "invalid partNumber" }, { status: 400 });
      }
      if (!request.body) {
        return json({ error: "missing body" }, { status: 400 });
      }
      return json(await upload.uploadPart(partNumber, request.body));
    }

    if (url.pathname === "/complete") {
      const { parts } = await request.json();
      if (!Array.isArray(parts)) {
        return json({ error: "missing parts" }, { status: 400 });
      }
      return json(await upload.complete(parts));
    }

    if (url.pathname === "/abort") {
      await upload.abort();
      return json({ ok: true });
    }

    return json({ error: "not found" }, { status: 404 });
  },
};
