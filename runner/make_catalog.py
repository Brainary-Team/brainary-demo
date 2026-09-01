#!/usr/bin/env python3
"""Derive a model catalog that pins every model to the multi-agent v1 backend.

Which backend a thread gets is decided by model metadata, not by feature flags:
`multi_agent_version_override()` can only produce V2 or Disabled, never V1. The one
lever that can force V1 is `model_catalog_json`, which replaces the process catalog.

This derives that catalog from `vendor/models.json` -- a verbatim copy of the catalog
the runtime bundles -- rather than checking in a second, hand-edited copy that would
drift against it. Point `--source` at another catalog if yours differs.

    make_catalog.py <out.json> [--source vendor/models.json]
"""
import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
DEFAULT_SOURCE = os.path.join(REPO, "vendor", "models.json")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--source", default=DEFAULT_SOURCE)
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    if not os.path.isfile(args.source):
        sys.exit(
            f"bundled catalog not found at {args.source}\n"
            "Pass --source if the workspace layout differs."
        )

    catalog = json.load(open(args.source))
    models = catalog.get("models")
    if not isinstance(models, list) or not models:
        sys.exit(f"{args.source} has no `models` array")

    flipped = []
    for m in models:
        # `disabled` is a deliberate opt-out; only redirect models that would pick v2.
        if m.get("multi_agent_version") == "v2":
            m["multi_agent_version"] = "v1"
            flipped.append(m.get("slug", "<unknown>"))
        elif m.get("multi_agent_version") is None:
            # Absent metadata falls through to feature flags, which default to v1 --
            # pin it anyway so the profile does not depend on that default.
            m["multi_agent_version"] = "v1"

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w") as fh:
        json.dump(catalog, fh, indent=2)

    if not args.quiet:
        print(
            f"catalog: {len(models)} models, forced v2->v1 for "
            f"{len(flipped)} ({', '.join(flipped) or 'none'})",
            file=sys.stderr,
        )


if __name__ == "__main__":
    main()
