---
layout: post
title: "Prefix cache hit rate is Not all you need"
date: 2026-09-27
---

In May 2026, an engineer named Marcus Chen [posted a debugging story](https://dev.to/marcuswwchen/prefix-caching-in-vllm-under-multi-tenant-agent-traffic-5e2j) that stuck with me. He had two tenants sharing one vLLM instance. One got a 68% prefix-cache hit rate. The other got 0.3%. Every dashboard looked fine, same engine, similar traffic, nothing red anywhere. He spent about a day and a half manually diffing prompts side by side before he found it: a session UUID sitting at token 47 of the system prompt, breaking every cache block after it.

What stuck with me wasn't the bug. It was that the lack of tooling to point to the problem. The engine could tell him prefix cache hit rate dropped but not why. So I built the tool for it. something that looks inside a prefix cache and says exactly where and why it's failing.

## Why the metrics can't tell you

vLLM, SGLang, TRT-LLM, and LMCache all expose the same shape of number: total cache hits over total cache queries, one counter per engine. Nothing per-tenant, nothing per-request, no sense of where in a prompt things started missing. If your aggregate hit rate drops from 70% to 40%, the engine can tell you it dropped. That's the whole report.

Finding the cause today means manually looking at prompts, the way Chen did. That doesn't scale past a handful of incidents, and it definitely doesn't scale to "why did tenant B specifically break."

## How the cache actually works

vLLM's prefix cache is a radix tree of token blocks, 16 tokens each by default. Each block's hash is `hash(parent_hash, block_tokens)`, chained to every block before it in the prompt. That chaining is what makes the cache correct: two requests only share a cached block if they share the *exact* history leading up to it, not just the same tokens in isolation.

It's also what makes a single miss expensive. If block 3 of a prompt doesn't match anything cached, every block after it gets a new hash too, even if the tokens in those later blocks are identical to something already sitting in the cache. One divergence early in a prompt poisons everything downstream of it. This is the mechanism, and it's the reason *where* a miss happens matters as much as *whether* it happens.

## Two diagnoses, one symptom

Once I had a working simulator, something non-obvious showed up: a miss hot-spot at the same block position across many requests looks identical whether the cause is a UUID stuck partway through the prompt, or a cache that's simply too small and evicting things before they get reused. Same symptom. Opposite fix, restructure the prompt in one case, add capacity in the other.

The way to tell them apart is to look at the actual token content at the miss position across every affected request, not just the fact that they all missed there. If the content differs every time, it's a variable field, get it out of the shared prefix. If the content is identical and it's still missing, the block isn't staying cached long enough to be reused, that's a capacity problem, not a prompt-structure one.

## Testing it against real traffic

I ran the tool, unmodified, against three real corpora: two chat datasets (WildChat, LMSys-Chat) and one batch-eval dataset (MMLU, 5-shot). The chat corpora both showed the same pattern. Misses cluster at the very first block of nearly every request, because different users share no common prefix at all. The only reuse available is within a single conversation.

MMLU showed the opposite shape. Every subject shares a fixed 5-example preamble across all of its questions, so the cache hits cleanly through that preamble and only misses once, at a block position specific to that subject, right where the actual question begins. Same tool, no configuration change between runs, two structurally different workloads, two correctly identified failure shapes.

## The tool

```
pip install prefixlens
```

Three commands: `analyze` for the corpus-wide report above, `explain` for one request's block-by-block trace, and `validate` to check the simulator against a real vLLM `/metrics` scrape before trusting anything it says.

```
$ prefixlens analyze traces.jsonl
  overall hit rate:  40.0%
  by tenant:
    acme      80.0%
    widgets    0.0%
  divergent positions for tenant=widgets:
    block 0   5 miss  (100% unique content)
```

## What it doesn't do yet

Right now it works at the token-block level, not the text level. It'll tell you block 0 is the problem, not that the actual culprit is `session_id=<uuid>`. Turning that into a real "move this field" recommendation needs a tokenizer wired in, which is next.

## Closing thought

Building this reinforced something I didn't expect going in: moving from backend infrastructure into AI systems isn't mostly about learning new things. Multi-tenant cache debugging, attributing a bad aggregate number back to a specific cause, telling a data problem apart from a capacity problem, none of that is new. It's the same instinct, pointed at a newer kind of cache.

The tool is open source. If you have real, anonymized traces from a multi-tenant deployment, try running this tool against them, that's the fastest way to find where it breaks.

[github.com/starparvinai/prefixlens](https://github.com/starparvinai/prefixlens)
