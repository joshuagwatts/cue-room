#!/usr/bin/env python3
"""Create the cue-room GitHub repo (if needed), seed it, enable Pages.
Uses the same credential surrogate pattern as gh_push.py."""
from __future__ import annotations
import json, os, sys, urllib.request, urllib.error

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import add_surrogate_to_request, read_json_response, read_response_body

API = "https://api.github.com"
ALLOWED = ("api.github.com",)
CRED = "custom.github"
REPO_NAME = "cue-room"

def api(method, path, payload=None, ok_codes=(200, 201, 204)):
    url = API + path
    data = None
    headers = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "muse-github-skill"}
    if payload is not None:
        data = json.dumps(payload).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    add_surrogate_to_request(req, CRED, allowed_hosts=ALLOWED)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            if resp.status == 204:
                return {}
            return read_json_response(resp)
    except urllib.error.HTTPError as exc:
        body = read_response_body(exc).decode("utf-8", errors="replace")[:1500]
        if exc.code in ok_codes:
            return {}
        raise RuntimeError(f"GitHub {method} {path} -> HTTP {exc.code}: {body}")

def main():
    user = api("GET", "/user")
    owner = user["login"]
    print("owner:", owner)
    repo_path = f"/repos/{owner}/{REPO_NAME}"
    try:
        repo = api("GET", repo_path)
        print("repo exists:", repo["full_name"])
    except RuntimeError as e:
        if "HTTP 404" not in str(e):
            raise
        repo = api("POST", "/user/repos", {"name": REPO_NAME, "private": False,
            "description": "Cue Room — one shared queue for the whole hangout. Scan, join, add a link; everyone hears the same thing at the same time.",
            "auto_init": True})
        print("repo created:", repo["full_name"])
    # Enable Pages from main / (root). 409/422 if already enabled — check state first.
    try:
        pages = api("GET", repo_path + "/pages")
        print("pages already:", pages.get("html_url"), pages.get("status"))
    except RuntimeError as e:
        if "HTTP 404" not in str(e):
            raise
        pages = api("POST", repo_path + "/pages", {"source": {"branch": "main", "path": "/"}})
        print("pages enabled:", pages.get("html_url"))
    print("OK", f"{owner}/{REPO_NAME}")

if __name__ == "__main__":
    raise SystemExit(main())
