#!/usr/bin/env bash
# Step 2 test: can a program (not a browser) reach Moxfield with our secret
# user-agent, and can it get a sign-in pass from the refresh cookie?
# Never prints secret values - only status codes, names and lifetimes.
# Waits >1 second between Moxfield requests (their rate limit is 1/second).

SECRETS="/c/Users/Zak/moxfield-secrets/moxfield.env"
DECK="h5OHZ1Tt7kWmsbinG9a_aQ"           # the unlisted "API test" deck
VERSION="2026.10.21.2"                  # x-moxfield-version seen in the browser
API="https://api2.moxfield.com"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

val() { grep -E "^$1=" "$SECRETS" | head -1 | cut -d= -f2- | tr -d '\r'; }
UA="$(val MOX_USER_AGENT)"
COOKIE="$(val MOX_REFRESH_COOKIE)"
USER_ID="$(val MOX_USER_ID)"

if [ -z "$UA" ] || [ "$UA" = "PASTE_USER_AGENT_HERE" ]; then
  echo "User-agent not filled in yet in $SECRETS"; exit 1; fi

pause() { sleep 1.2; }

echo "== Test A: request WITHOUT the user-agent (expect blocked, 403)"
code=$(curl -s -o /dev/null -w "%{http_code}" "$API/v3/decks/all/$DECK")
echo "   status: $code"
pause

echo "== Test B: same request WITH the user-agent (expect 200)"
code=$(curl -s -o "$TMP/deck.json" -w "%{http_code}" -A "$UA" \
  -H "x-moxfield-version: $VERSION" "$API/v3/decks/all/$DECK")
echo "   status: $code"
if [ "$code" = "200" ]; then
  echo "   deck name: $(grep -o '"name":"[^"]*"' "$TMP/deck.json" | head -1)"
  if [ -z "$USER_ID" ]; then
    USER_ID=$(grep -o '"authors":\[{"userId":"[^"]*"' "$TMP/deck.json" | head -1 | sed 's/.*"userId":"//; s/"$//')
    [ -z "$USER_ID" ] && USER_ID=$(grep -o '"userId":"[^"]*"' "$TMP/deck.json" | head -1 | sed 's/.*"userId":"//; s/"$//')
    [ -n "$USER_ID" ] && echo "   found the account's user id in the deck data (not shown)"
  fi
fi

if [ -z "$COOKIE" ] || [ "$COOKIE" = "PASTE_COOKIE_HERE" ]; then
  echo; echo "Refresh cookie not filled in yet - stopping after the user-agent tests."; exit 0; fi
pause

echo "== Test C: trade the refresh cookie for an access token"
code=$(curl -s -D "$TMP/h.txt" -o "$TMP/tok.json" -w "%{http_code}" -A "$UA" \
  -H "x-moxfield-version: $VERSION" -H "Content-Type: application/json" \
  -H "Cookie: $COOKIE" -X POST \
  --data "{\"userId\":\"$USER_ID\",\"isAppLogin\":false}" "$API/v1/account/token/refresh")
echo "   status: $code"
TOKEN=$(grep -o '"access_token":"[^"]*"' "$TMP/tok.json" | sed 's/.*:"//; s/"$//')
if [ -n "$TOKEN" ]; then
  payload=$(echo "$TOKEN" | cut -d. -f2 | tr '_-' '/+'); while [ $(( ${#payload} % 4 )) -ne 0 ]; do payload="$payload="; done
  claims=$(echo "$payload" | base64 -d 2>/dev/null)
  iat=$(echo "$claims" | grep -o '"iat":[0-9]*' | cut -d: -f2); exp=$(echo "$claims" | grep -o '"exp":[0-9]*' | cut -d: -f2)
  [ -n "$iat" ] && [ -n "$exp" ] && echo "   access token lasts: $(( (exp - iat) / 60 )) minutes"
else
  echo "   no access token in reply; reply fields: $(grep -o '"[a-zA-Z_]*":' "$TMP/tok.json" | tr -d '":' | tr '\n' ' ')"
fi
# Report any new cookies (names + lifetimes only). MOX_REFRESH_COOKIE may hold
# several cookies ("a=1; b=2"); if the server replaces one, save the new value
# so we don't lose access.
NEWCOOKIE="$COOKIE"
while IFS= read -r line; do
  nv="${line#*: }"; nv="${nv%%;*}"; name="${nv%%=*}"
  life=$(echo "$line" | grep -o -i -E '(max-age=[0-9]+|expires=[^;]*)' | head -1)
  echo "   server set cookie: $name  ($life)"
  NEWCOOKIE=$(printf '%s' "$NEWCOOKIE" | tr ';' '\n' | sed 's/^ *//' | \
    awk -v n="$name" -v nv="$nv" 'BEGIN{FS="="} $1==n{print nv; f=1; next} {print} END{if(!f) print nv}' | \
    grep -v '^$' | paste -sd ';' | sed 's/;/; /g')
done < <(grep -i '^set-cookie:' "$TMP/h.txt" | grep -i 'refresh')
if [ "$NEWCOOKIE" != "$COOKIE" ]; then
  esc=$(printf '%s' "$NEWCOOKIE" | sed 's/[&|\\]/\\&/g')
  sed -i "s|^MOX_REFRESH_COOKIE=.*|MOX_REFRESH_COOKIE=$esc|" "$SECRETS"
  echo "   -> refresh cookie(s) were replaced; saved the new ones to the secrets file"
fi
[ -z "$TOKEN" ] && exit 0
pause

echo "== Test D: a signed-in request (list the account's deck folders, expect 200)"
code=$(curl -s -o /dev/null -w "%{http_code}" -A "$UA" -H "x-moxfield-version: $VERSION" \
  -H "Authorization: Bearer $TOKEN" -H "X-Session-User: $USER_ID" "$API/v1/deck-folders")
echo "   status: $code"
