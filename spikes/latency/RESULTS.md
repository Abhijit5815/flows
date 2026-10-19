# Latency spike results (Phase 0)

Written by `npm run bench:latency`. The target is p95 < 100 ms for embed + match on CPU (PLAN.md Phase 0).

- Date: 2026-10-19
- CPU: Apple M4, 10 cores; RAM 16 GB; Darwin 25.6.0
- Node v25.3.0; @huggingface/transformers 4.3.1; onnxruntime-node 1.30.0; device cpu; ONNX Runtime session options left at their defaults
- Each input size: 20 warm-up calls, then 300 timed calls, one text per call (batch size 1, like decide())
- Match: dot product against 1000 prototype vectors (10 labels x 100), best score per label
- Times in milliseconds. Load = second load of the model, read from the local cache

| Model | dtype | Source | Dims | Load (s) | Input | Tokens (mean) | Embed p50 | Embed p95 | Match p95 | Total p50 | Total p95 | Total p99 | Max | p95 < 100 ms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| BAAI/bge-small-en-v1.5 | fp32 | publisher | 384 | 0.1 | short | 19 | 2.6 | 3.7 | 0.6 | 2.9 | **4.3** | 7.0 | 7.9 | yes |
| BAAI/bge-small-en-v1.5 | fp32 | publisher | 384 | 0.1 | medium | 66 | 5.8 | 7.4 | 0.6 | 6.1 | **7.9** | 8.6 | 11.3 | yes |
| BAAI/bge-small-en-v1.5 | fp32 | publisher | 384 | 0.1 | long | 340 | 23.6 | 26.9 | 0.6 | 24.0 | **27.3** | 29.2 | 35.3 | yes |
| Xenova/bge-small-en-v1.5 | q8 | copy, no license stated | 384 | 0.1 | short | 19 | 2.2 | 3.5 | 0.6 | 2.6 | **3.9** | 4.8 | 9.3 | yes |
| Xenova/bge-small-en-v1.5 | q8 | copy, no license stated | 384 | 0.1 | medium | 66 | 6.2 | 9.2 | 0.6 | 6.5 | **9.8** | 10.3 | 12.5 | yes |
| Xenova/bge-small-en-v1.5 | q8 | copy, no license stated | 384 | 0.1 | long | 340 | 28.8 | 33.5 | 0.6 | 29.1 | **33.9** | 34.9 | 36.8 | yes |
| BAAI/bge-m3 | fp32 | publisher | 1024 | 0.6 | short | 20 | 21.4 | 24.2 | 1.5 | 22.2 | **25.3** | 26.3 | 28.1 | yes |
| BAAI/bge-m3 | fp32 | publisher | 1024 | 0.6 | medium | 69 | 48.1 | 51.8 | 1.5 | 48.9 | **53.1** | 55.5 | 77.7 | yes |
| BAAI/bge-m3 | fp32 | publisher | 1024 | 0.6 | long | 350 | 210.1 | 233.2 | 1.5 | 210.9 | **234.2** | 285.0 | 294.7 | no |
| Xenova/bge-m3 | q8 | copy, states MIT | 1024 | 0.6 | short | 20 | 12.0 | 19.8 | 1.5 | 13.2 | **20.8** | 24.1 | 49.4 | yes |
| Xenova/bge-m3 | q8 | copy, states MIT | 1024 | 0.6 | medium | 69 | 39.4 | 48.6 | 1.5 | 40.4 | **49.6** | 56.3 | 81.2 | yes |
| Xenova/bge-m3 | q8 | copy, states MIT | 1024 | 0.6 | long | 350 | 210.6 | 234.9 | 1.5 | 211.6 | **235.9** | 265.3 | 298.5 | no |
| onnx-community/Qwen3-Embedding-0.6B-ONNX | fp32 | copy, no license stated | 1024 | 0.7 | short | 14 | 30.2 | 36.0 | 1.5 | 31.2 | **36.9** | 45.0 | 87.0 | yes |
| onnx-community/Qwen3-Embedding-0.6B-ONNX | fp32 | copy, no license stated | 1024 | 0.7 | medium | 46 | 52.6 | 65.7 | 1.5 | 53.6 | **66.9** | 95.2 | 190.1 | yes |
| onnx-community/Qwen3-Embedding-0.6B-ONNX | fp32 | copy, no license stated | 1024 | 0.7 | long | 278 | 256.7 | 286.5 | 1.5 | 258.0 | **287.4** | 297.6 | 324.9 | no |
| onnx-community/Qwen3-Embedding-0.6B-ONNX | q8 | copy, no license stated | 1024 | 0.5 | short | 14 | 19.4 | 29.6 | 1.5 | 20.6 | **30.7** | 34.3 | 37.7 | yes |
| onnx-community/Qwen3-Embedding-0.6B-ONNX | q8 | copy, no license stated | 1024 | 0.5 | medium | 46 | 53.0 | 63.7 | 1.6 | 54.3 | **65.3** | 69.3 | 73.8 | yes |
| onnx-community/Qwen3-Embedding-0.6B-ONNX | q8 | copy, no license stated | 1024 | 0.5 | long | 278 | 351.0 | 395.4 | 1.8 | 352.4 | **397.0** | 404.6 | 475.8 | no |

