#!/usr/bin/env bash
# Regression test for deploy/post-demo-signals.sh's is_transient_error()
# and live_pass_should_fail().
#
# Exists because on 2026-10-22 at 13:36 UTC the testnet RPC answered one
# post_sub_signals call from the Railway --live poster with a 502:
#
#   FATAL: hour 497964 sub 11: error: ❌ error: Request rejected `502`
#
# is_transient_error() did not recognise that message, so the sub-epoch
# was treated as a real rejection, the run exited non-zero, the Railway
# deployment was marked crashed and no scheduled run happened for 11
# hours. A gateway error is a network hiccup, not an answer from the
# chain, so it must get the same one retry and "deferred" handling as
# the other transient messages.
#
# The same outage showed a second problem: that 502 hit the run's only
# NEW sub-epoch, so even once it is deferred instead of fatal, the old
# "posted 0 and deferred 1 means fail" rule would still have crashed
# the run. live_pass_should_fail() now only fails a pass once a
# deferred sub-epoch has been unposted for longer than the limit.
#
# Also checks the guards that must not move: a contract error is never
# transient, even when its text happens to contain a matching string,
# and a 4xx rejection is not transient.
#
# Extracts the real function body out of deploy/post-demo-signals.sh
# and evals it directly, same self-extraction pattern the other
# deploy/test-*.sh files use. No network calls.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
POSTER_SH="$REPO_ROOT/deploy/post-demo-signals.sh"

FAILED=0

func_src="$(sed -n '/^is_transient_error() {/,/^}/p' "$POSTER_SH")"
[[ -n "$func_src" ]] || { echo "FATAL: could not extract is_transient_error() from $POSTER_SH - has it been renamed?" >&2; exit 1; }
eval "$func_src"

should_fail_src="$(sed -n '/^live_pass_should_fail() {/,/^}/p' "$POSTER_SH")"
[[ -n "$should_fail_src" ]] || { echo "FATAL: could not extract live_pass_should_fail() from $POSTER_SH - has it been renamed?" >&2; exit 1; }
eval "$should_fail_src"

limit="$(sed -n 's/^LIVE_DEFERRED_FAIL_AFTER_SECS=\([0-9]*\)$/\1/p' "$POSTER_SH")"
[[ -n "$limit" ]] || { echo "FATAL: could not read LIVE_DEFERRED_FAIL_AFTER_SECS from $POSTER_SH" >&2; exit 1; }

expect() {
  local label="$1" want="$2" msg="$3"
  local got=no
  if is_transient_error "$msg"; then got=yes; fi
  if [[ "$got" != "$want" ]]; then
    echo "FAIL: $label - expected transient=$want, got transient=$got" >&2
    FAILED=1
  else
    echo "PASS: $label -> transient=$got"
  fi
}

# The exact output this fix exists for, as the CLI printed it on Railway.
expect "observed 502 from the Railway poster" yes 'error: ❌ error: Request rejected `502`'
expect "503 gateway error" yes 'error: ❌ error: Request rejected `503`'
expect "504 gateway error" yes 'error: ❌ error: Request rejected `504`'

# The messages that were already transient must stay transient.
expect "submission timeout" yes 'error: transaction submission timeout'
expect "body read error" yes 'error: error reading a body from connection'
expect "SendRequest" yes 'error: client error (SendRequest)'
expect "Connect" yes 'error: client error (Connect)'
expect "txBadSeq" yes 'error: transaction failed: txBadSeq'

# Not transient: a client-side rejection will fail the same way on retry.
expect "400 is a real rejection" no 'error: ❌ error: Request rejected `400`'
expect "500 is not in the list" no 'error: ❌ error: Request rejected `500`'
expect "a bare 502 elsewhere in text" no 'error: wrote 502 bytes'

# Hard guard: a contract error is never transient, even if it mentions 502.
expect "contract error mentioning 502" no 'error: HostError: Error(Contract, #120) ... Request rejected `502`'
expect "already-posted contract error" no 'error: HostError: Error(Contract, #103)'

expect_fail() {
  local label="$1" want="$2" posted="$3" deferred="$4" age="$5"
  local got=no
  if live_pass_should_fail "$posted" "$deferred" "$age" "$limit"; then got=yes; fi
  if [[ "$got" != "$want" ]]; then
    echo "FAIL: $label - expected fail=$want, got fail=$got" >&2
    FAILED=1
  else
    echo "PASS: $label -> fail=$got"
  fi
}

# The 2026-10-22 case: the only new sub-epoch was deferred seconds after
# it closed. Must not fail the run.
expect_fail "single blip on the only new sub-epoch" no 0 1 65
# The quiet, healthy case: nothing new, nothing deferred.
expect_fail "nothing to do" no 0 0 0
# Something posted, so the RPC is reachable, whatever else was deferred.
expect_fail "posted one, another deferred for long" no 1 1 $(( limit + 600 ))
# Exactly at the limit is still a pass; one second past it fails.
expect_fail "deferred exactly at the limit" no 0 1 "$limit"
expect_fail "deferred one second past the limit" yes 0 1 $(( limit + 1 ))
# A sustained outage: several ticks have failed to post the same sub-epoch.
expect_fail "sustained outage" yes 0 3 $(( limit * 2 ))

if (( FAILED )); then
  echo "is_transient_error / live_pass_should_fail regression test FAILED" >&2
  exit 1
fi
echo "is_transient_error / live_pass_should_fail regression test passed"
