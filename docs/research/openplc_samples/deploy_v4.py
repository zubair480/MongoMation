#!/usr/bin/env python3
"""Reference deploy client for OpenPLC Runtime v4 (verified against v4.3.0).

Sequence (same as openplc-editor's deployRuntimeProgram):
  GET  /api/capabilities                (no auth)  -> runtimeVersion must be >= v4.1.0 for STruC++ bundles
  GET  /api/get-users-info              (no auth)  -> 404 {"msg":"No users found"} on a fresh runtime
  POST /api/create-user  {username,password}       -> 201 (only allowed unauthenticated while no user exists)
  POST /api/login        {username,password}       -> 200 {"access_token": JWT}  (expires after 15 min)
  POST /api/upload-file  multipart field "file" = program.zip -> {"UploadFileFail":"", "CompilationStatus":"COMPILING", ...}
  GET  /api/compilation-status (poll 1 s)          -> {"status": IDLE|UNZIPPING|COMPILING|SUCCESS|FAILED, "logs": [...], "exit_code": null|0|1|-1}
  GET  /api/start-plc (retry while "COMMAND:BUSY") -> {"status":"START:OK"}
  GET  /api/status   (poll until STATUS:RUNNING)   -> {"status":"STATUS:RUNNING","switchPosition":"run"}

usage: deploy_v4.py --host H --user U --password P --zip program.zip [--port 8443]
                    [--cafile certOPENPLC.pem | --insecure] [--create-user] [--clean]
"""
import argparse
import json
import ssl
import sys
import time
import urllib.error
import urllib.request
import uuid


class Runtime:
    def __init__(self, host: str, port: int, ctx: ssl.SSLContext) -> None:
        self.base = f"https://{host}:{port}/api"
        self.ctx = ctx
        self.token = ""

    def call(self, method: str, path: str, body: bytes | None = None,
             headers: dict[str, str] | None = None, auth: bool = True) -> tuple[int, object]:
        h = dict(headers or {})
        if auth and self.token:
            h["Authorization"] = f"Bearer {self.token}"
        req = urllib.request.Request(self.base + path, data=body, method=method, headers=h)
        try:
            with urllib.request.urlopen(req, context=self.ctx, timeout=300) as r:
                raw, code = r.read(), r.status
        except urllib.error.HTTPError as e:
            raw, code = e.read(), e.code
        try:
            return code, json.loads(raw or b"null")
        except json.JSONDecodeError:
            return code, raw.decode("utf-8", "replace")

    def json_post(self, path: str, payload: dict, auth: bool = True) -> tuple[int, object]:
        return self.call("POST", path, json.dumps(payload).encode(),
                         {"Content-Type": "application/json"}, auth)

    def upload(self, zip_bytes: bytes, clean: bool) -> tuple[int, object]:
        boundary = "----mongomation" + uuid.uuid4().hex
        body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; "
                f"filename=\"program.zip\"\r\nContent-Type: application/zip\r\n\r\n").encode()
        body += zip_bytes + f"\r\n--{boundary}--\r\n".encode()
        path = "/upload-file?clean=1" if clean else "/upload-file"
        return self.call("POST", path, body,
                         {"Content-Type": f"multipart/form-data; boundary={boundary}"})


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", required=True)
    ap.add_argument("--port", type=int, default=8443)
    ap.add_argument("--user", required=True)
    ap.add_argument("--password", required=True)
    ap.add_argument("--zip", required=True)
    ap.add_argument("--cafile", help="pin the runtime's self-signed certOPENPLC.pem")
    ap.add_argument("--insecure", action="store_true", help="skip TLS verification (self-signed)")
    ap.add_argument("--create-user", action="store_true")
    ap.add_argument("--clean", action="store_true")
    a = ap.parse_args()

    if a.cafile:
        ctx = ssl.create_default_context(cafile=a.cafile)
        ctx.check_hostname = False  # cert is issued for localhost/127.0.0.1 only
    elif a.insecure:
        ctx = ssl._create_unverified_context()  # noqa: SLF001 - self-signed runtime cert
    else:
        ctx = ssl.create_default_context()
    rt = Runtime(a.host, a.port, ctx)

    code, caps = rt.call("GET", "/capabilities", auth=False)
    print("capabilities:", code, caps)

    code, users = rt.call("GET", "/get-users-info", auth=False)
    if code == 404 and a.create_user:
        print("create-user:", rt.json_post("/create-user", {"username": a.user, "password": a.password}, auth=False))

    code, login = rt.json_post("/login", {"username": a.user, "password": a.password}, auth=False)
    if code != 200 or not isinstance(login, dict):
        print("login failed:", code, login)
        return 6
    rt.token = login["access_token"]

    with open(a.zip, "rb") as f:
        code, up = rt.upload(f.read(), a.clean)
    print("upload:", code, up)
    if code != 200 or not isinstance(up, dict) or up.get("UploadFileFail"):
        return 7

    seen = 0
    deadline = time.monotonic() + 20 * 60
    status: dict = {}
    while time.monotonic() < deadline:
        time.sleep(1)
        code, st = rt.call("GET", "/compilation-status")
        if code == 401:  # token expired mid-build: log in again
            rt.token = rt.json_post("/login", {"username": a.user, "password": a.password}, auth=False)[1]["access_token"]
            continue
        status = st if isinstance(st, dict) else {}
        for line in status.get("logs", [])[seen:]:
            print("  build|", line.rstrip())
        seen = len(status.get("logs", []))
        if status.get("status") in ("SUCCESS", "FAILED"):
            break
    print("compilation:", status.get("status"), "exit_code", status.get("exit_code"))
    if status.get("status") != "SUCCESS":
        return 4

    t_end = time.monotonic() + 5
    while True:
        code, r = rt.call("GET", "/start-plc")
        s = r.get("status", "") if isinstance(r, dict) else str(r)
        if "BUSY" in s and time.monotonic() < t_end:
            time.sleep(0.15)
            continue
        print("start-plc:", s)
        break
    for _ in range(50):
        code, r = rt.call("GET", "/status")
        if isinstance(r, dict) and r.get("status") in ("STATUS:RUNNING", "STATUS:EMPTY", "STATUS:ERROR"):
            break
        time.sleep(0.2)
    print("status:", r)
    return 0 if isinstance(r, dict) and r.get("status") == "STATUS:RUNNING" else 7


if __name__ == "__main__":
    sys.exit(main())
