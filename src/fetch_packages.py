"""Download the official HL7 FHIR packages this project indexes.

Usage: python -I src/fetch_packages.py data/packages
"""
import os
import sys
import urllib.request

PACKAGES = [
    ("hl7.fhir.r4.core", "4.0.1"),
    ("hl7.fhir.r4b.core", "4.3.0"),
    ("hl7.fhir.r5.core", "5.0.0"),
    ("hl7.fhir.uv.extensions.r4", "5.3.0"),
    ("hl7.fhir.uv.extensions.r5", "5.3.0"),
]


def main(out_dir):
    os.makedirs(out_dir, exist_ok=True)
    for name, version in PACKAGES:
        target = os.path.join(out_dir, f"{name}#{version}.tgz")
        if os.path.exists(target):
            print(f"already have {name}#{version}")
            continue
        url = f"https://packages.fhir.org/{name}/{version}"
        print(f"downloading {url}")
        with urllib.request.urlopen(url, timeout=300) as resp, open(target, "wb") as f:
            f.write(resp.read())


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "data/packages")
