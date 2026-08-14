#!/usr/bin/env python3
"""Embed all chunks in Supabase using BGE-small-en-v1.5.

Generates 384-dim normalised vectors and stores them in the `embedding`
column of the `chunks` table.  The same model MUST be used at query time
(in the model server's /embed endpoint) so that cosine distances are
meaningful.

Usage:
    python embed_chunks.py                    # embed un-embedded chunks
    python embed_chunks.py --business-id 13   # one business only
    python embed_chunks.py --reembed          # re-embed everything

Requires:
    pip install sentence-transformers supabase python-dotenv
"""

import os
import argparse
from pathlib import Path

from dotenv import load_dotenv
from sentence_transformers import SentenceTransformer
from supabase import create_client

# Load .env from backend/
load_dotenv(Path(__file__).resolve().parent.parent / ".env")

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
EMBED_MODEL  = "BAAI/bge-small-en-v1.5"
BATCH_SIZE   = 64


def main():
    parser = argparse.ArgumentParser(description="Embed Supabase chunks with BGE-small")
    parser.add_argument("--business-id", type=int, default=None,
                        help="Only embed chunks for this business")
    parser.add_argument("--business-id-range", type=str, default=None,
                        help="Embed chunks for a range of business IDs, e.g. 0-15")
    parser.add_argument("--reembed", action="store_true",
                        help="Re-embed all chunks (not just missing)")
    args = parser.parse_args()

    print(f"Loading embedding model: {EMBED_MODEL}")
    model = SentenceTransformer(EMBED_MODEL)

    sb = create_client(SUPABASE_URL, SUPABASE_KEY)

    # Build list of business IDs to process
    biz_ids = None
    if args.business_id is not None:
        biz_ids = [args.business_id]
    elif args.business_id_range:
        lo, hi = args.business_id_range.split("-")
        biz_ids = list(range(int(lo), int(hi) + 1))

    # Fetch chunks needing embeddings
    query = sb.table("chunks").select("id, chunk_text")
    if biz_ids is not None and len(biz_ids) == 1:
        query = query.eq("business_id", biz_ids[0])
    elif biz_ids is not None:
        query = query.in_("business_id", biz_ids)
    if not args.reembed:
        query = query.is_("embedding", "null")

    chunks = query.execute().data
    print(f"Found {len(chunks)} chunks to embed")

    if not chunks:
        print("Nothing to do.")
        return

    # Batch embed + update
    for i in range(0, len(chunks), BATCH_SIZE):
        batch = chunks[i : i + BATCH_SIZE]
        texts = [c["chunk_text"] for c in batch]
        embs = model.encode(texts, normalize_embeddings=True)

        for chunk, emb in zip(batch, embs):
            sb.table("chunks").update(
                {"embedding": emb.tolist()}
            ).eq("id", chunk["id"]).execute()

        done = min(i + BATCH_SIZE, len(chunks))
        print(f"  Embedded {done}/{len(chunks)}")

    print("Done!")


if __name__ == "__main__":
    main()
