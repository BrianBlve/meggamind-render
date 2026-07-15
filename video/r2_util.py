#!/usr/bin/env python3
"""Mini utilidad R2 para los jobs de color (boto3). Env: R2_ACCOUNT_ID/R2_ACCESS_KEY_ID/
R2_SECRET_ACCESS_KEY/R2_BUCKET.  Uso: r2_util.py down <key> <destino> | up <archivo> <key>"""
import sys, os, boto3

E = os.environ
s3 = boto3.client("s3",
    endpoint_url=f"https://{E['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
    aws_access_key_id=E["R2_ACCESS_KEY_ID"],
    aws_secret_access_key=E["R2_SECRET_ACCESS_KEY"],
    region_name="auto")

cmd, a, b = sys.argv[1], sys.argv[2], sys.argv[3]
if cmd == "down":
    os.makedirs(os.path.dirname(b) or ".", exist_ok=True)
    s3.download_file(E["R2_BUCKET"], a, b)
    print(f"R2 {a} -> {b} ({os.path.getsize(b)/1e6:.1f} MB)")
elif cmd == "up":
    s3.upload_file(a, E["R2_BUCKET"], b)
    print(f"{a} -> R2 {b} ({os.path.getsize(a)/1e6:.1f} MB)")
else:
    sys.exit(f"comando desconocido: {cmd}")
