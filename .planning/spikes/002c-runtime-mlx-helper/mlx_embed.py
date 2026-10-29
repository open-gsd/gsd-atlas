"""Out-of-process MLX embedding helper (spike 002c). Reads a JSON list of strings, writes a JSON list of float lists.
usage: mlx_embed.py <hf-repo> <in.json> <out.json> [batch]
Runs only inside the spike-local venv (.planning/spikes/.venv-mlx). Models come from the Hugging Face cache (HF_HOME)."""
import json
import sys
import time

import mlx.core as mx
from mlx_embeddings import load

repo, src, dst = sys.argv[1:4]
batch = int(sys.argv[4]) if len(sys.argv) > 4 else 16
texts = json.load(open(src))
t0 = time.time()
model, tok = load(repo)
load_s = time.time() - t0
out = []
for i in range(0, len(texts), batch):
    enc = tok.batch_encode_plus(texts[i : i + batch], return_tensors="mlx", padding=True, truncation=True, max_length=512)
    res = model(enc["input_ids"], attention_mask=enc["attention_mask"])
    emb = res.text_embeds
    mx.eval(emb)
    out.extend(emb.tolist())
json.dump({"load_s": load_s, "vectors": out}, open(dst, "w"))
