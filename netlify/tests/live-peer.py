"""Synthetic HTTPS peer. Private values travel only through parent/child pipes."""
import json
import secrets
import sys
import urllib.error
import urllib.request


def main():
    config = json.load(sys.stdin)
    base = config["origin"]
    if base != "https://agents-link.netlify.app":
        raise ValueError("Unexpected test origin")
    credential = "lks2." + secrets.token_urlsafe(32)

    def call(path, body=None, method=None, authenticated=True):
        headers = {"Accept": "application/json"}
        if authenticated:
            headers["Authorization"] = "Bearer " + credential
        data = None if body is None else json.dumps(body).encode("utf-8")
        if data is not None:
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(base + "/link/v1" + path, data=data, headers=headers, method=method)
        with urllib.request.urlopen(request, timeout=40) as response:
            return json.load(response)

    info = call("/info", authenticated=False)
    assert info["hosting"] == "netlify"
    joined = call("/join", {"invitation": config["invitation"], "name": "Synthetic Python peer", "consentToPlaintextGateway": True})
    received = call("/receive", {"waitMs": 0})
    assert any(message["text"] == config["expectedText"] for message in received["messages"])
    call("/confirm", {"cursor": received["nextCursor"], "read": True})
    sent = call("/send", {"text": "Synthetic Python reply: HTTPS round trip confirmed.", "requestId": "live-python-reply"})
    json.dump({"credential": credential, "participantId": joined["participantId"], "roomId": joined["roomId"], "messageId": sent["messageId"], "pythonVersion": sys.version.split()[0]}, sys.stdout)


try:
    main()
except urllib.error.HTTPError as error:
    print(json.dumps({"error": "HTTP_ERROR", "status": error.code}), file=sys.stderr)
    sys.exit(1)
except Exception as error:
    print(json.dumps({"error": type(error).__name__}), file=sys.stderr)
    sys.exit(1)
