# Bonsai 2 27B (PTQ1_0 ternary) on Intel Arc B580

This branch makes PrismML's ternary Bonsai 2 27B run fast on a 12 GB Intel Arc B580 (Xe2, "Battlemage") with the SYCL
backend, at the full 128K context. The Vulkan backend got most of the same kernel work, but SYCL is clearly faster on
this card.

## Results

B580 12 GB, Linux, oneAPI 2025.3, Level Zero driver 26.35. Everything below is at 131072 context with a q4_0 KV cache,
speculative decoding on (MTP head, 3 drafts, plus n-gram drafts), thinking off.

|                                   | SYCL (this branch) | Vulkan (this branch) |
|-----------------------------------|--------------------|----------------------|
| Fresh code answer                 | 83 t/s             | 53 t/s               |
| Rename a symbol in pasted code    | 361 t/s            | 194 t/s              |
| Small edit to pasted code         | 250 t/s            | 135 t/s              |
| Plain generation, no speculation  | 41 t/s             | 32 t/s               |
| 29K-token document: prompt / gen  | 786 / 40 t/s       | 281 / 29 t/s         |

Speculation speed depends on the text. New prose drafts worse than code (expect roughly 50-60 t/s); rewriting text that
is already in the conversation drafts very well. Quality: KL divergence against the reference logits is 0.00022
(99.2% same top token; the plain PTQ1_0 kernels score 0.0003), and greedy outputs on our test prompts are byte-identical to the plain PTQ1_0 kernels.

## What changed

- **Ternary weights on the XMX matrix units.** At load, every PTQ1_0 weight is repacked in place to a 2-bit layout and
  multiplied with the int8 x int2 DPAS kernels from [libxsmm/TernSYCL](https://github.com/libxsmm/TernSYCL) (BSD 3-Clause,
  vendored in `ggml/src/ggml-sycl/ternsycl`). The base-3 PTQ1_0 packing has to be decoded on the ALUs first, which made
  the multi-token verify step of speculative decoding compute-bound. The 2-bit layout costs about 31% more weight memory.
  Activations are quantized to int8 with round-to-nearest (TernSYCL truncates; rounding to nearest cut KLD 5x).
- **Decode attention for a q4_0 KV cache** serving 1-4 query tokens per launch from one read of the cache (GQA-aware).
- **Gated delta-net** blocked kernel, fused state writes, and several fusions for single-token decode (same-input mat-vecs
  in one launch, narrow concat, fused gate/up).
- **Memory for 128K on 12 GB:** the MTP draft context now takes its own KV cache type (`-ctkd/-ctvd q4_0`) and a smaller
  physical batch (`LLAMA_ARG_SPEC_DRAFT_UBATCH=512`), and the main prompt batch is 1024.

## Build (SYCL)

Needs the Intel oneAPI Base Toolkit 2025.3 or newer and a recent Level Zero GPU driver.

```sh
source /opt/intel/oneapi/setvars.sh
cmake -B build-sycl -DGGML_SYCL=ON -DCMAKE_C_COMPILER=icx -DCMAKE_CXX_COMPILER=icpx \
      -DCMAKE_BUILD_TYPE=Release -DGGML_SYCL_TARGET=INTEL
cmake --build build-sycl -j --target llama-server llama-bench llama-cli
```

## Run

```sh
source /opt/intel/oneapi/setvars.sh
export GGML_SYCL_PTQ1_T2=all              # PTQ1_0 weights on XMX (ffn = feed-forward only, unset = off)
export LLAMA_ARG_SPEC_DRAFT_UBATCH=512    # smaller compute buffer for the MTP draft context
./build-sycl/bin/llama-server -m <bonsai-2-27b-ptq1_0-with-mtp>.gguf -ngl 99 \
  -c 131072 -ctk q4_0 -ctv q4_0 -ctkd q4_0 -ctvd q4_0 -np 1 \
  --spec-type draft-mtp,ngram-mod --spec-draft-n-max 3 --spec-ngram-mod-n-max 256 \
  -ub 1024 -b 2048 --chat-template-kwargs '{"enable_thinking":false}' --host 0.0.0.0 --port 8080
```

With a shorter context you can use `-ub 2048` for faster prompt reading. `GGML_SYCL_PTQ1_T2=ffn` puts only the
feed-forward weights on XMX: about 380 MiB less weight memory, enough for `-ub 2048` at 128K, and most of the speed
(fresh 80, rename 314, edit 213).

The first long prompt after the very first start compiles the XMX kernels (about 30 s); the GPU driver caches them after
that. If the server ever hangs during start-up in GPU initialisation after being killed mid-compile, move
`~/.cache/neo_compiler_cache` aside.

## Switches

All optimisations are on by default except the XMX path. Set any of these to turn a piece off for comparison:
`GGML_SYCL_PTQ1_T2_GEMM_OFF`, `GGML_SYCL_PTQ1_MULTI=0`, `GGML_SYCL_PTQ1_MULTI_NCOLS=0`, `GGML_SYCL_PTQ1_GLU1=0`,
`GGML_SYCL_PTQ1_PAIRS=0`, `GGML_SYCL_PTQ1_NCOLS_DEC_OFF`, `GGML_SYCL_FA_DEC_OFF`, `GGML_SYCL_GDN_BLOCKED_OFF`,
`GGML_SYCL_GLU_FUSE_OFF`.

## Credits

Built on [llama.cpp](https://github.com/ggml-org/llama.cpp) (MIT), PrismML's PTQ1_0 support, and the `bonsai-combo`
branch of [professorpalmer/llama.cpp-ada-ternary](https://github.com/professorpalmer/llama.cpp-ada-ternary) (PrismML
PR #221) that this branch started from, with the ternary DPAS
kernels from [libxsmm/TernSYCL](https://github.com/libxsmm/TernSYCL) (BSD 3-Clause; licence and notice included).
