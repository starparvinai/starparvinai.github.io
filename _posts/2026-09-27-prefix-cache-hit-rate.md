---
layout: post
title: "Prefix cache hit rate is Not all you need"
date: 2026-09-27
---

In May 2026, an engineer named Marcus Chen [posted a debugging story](https://dev.to/marcuswwchen/prefix-caching-in-vllm-under-multi-tenant-agent-traffic-5e2j) that stuck with me. He had two tenants sharing one vLLM instance. One got a 68% prefix-cache hit rate. The other got 0.3%. Every dashboard looked fine, same engine, similar traffic, nothing red anywhere. He spent about a day and a half manually diffing prompts side by side before he found it: a session UUID sitting at token 47 of the system prompt, breaking every cache block after it.

What stuck with me wasn't the bug, it was the absence of any tool that could have pointed at it. The engine could tell him the hit rate dropped. It could not tell him why. So I built the thing I wanted to exist: something that looks inside a prefix cache and says exactly where it's failing, and what to change.

## Why the metrics can't tell you

vLLM, SGLang, TRT-LLM, and LMCache all expose the same shape of number: total cache hits over total cache queries, one counter per engine. Nothing per-tenant, nothing per-request, no sense of where in a prompt things started missing. If your aggregate hit rate drops from 70% to 40%, the engine can tell you it dropped. That's the whole report.

Finding the cause today means manually looking at prompts, the way Chen did. That doesn't scale past a handful of incidents, and it definitely doesn't scale to "why did tenant B specifically break."

## How the cache actually works

vLLM's prefix cache is a radix tree of token blocks, 16 tokens each by default. Each block's hash is `hash(parent_hash, block_tokens)`, chained to every block before it in the prompt. That chaining is what makes the cache correct: two requests only share a cached block if they share the *exact* history leading up to it, not just the same tokens in isolation.

It's also what makes a single miss expensive. If block 3 of a prompt doesn't match anything cached, every block after it gets a new hash too, even if the tokens in those later blocks are identical to something already sitting in the cache. One divergence early in a prompt poisons everything downstream of it. This is the mechanism, and it's the reason *where* a miss happens matters as much as *whether* it happens.

## Three shapes, one symptom

Once I had a working simulator, something non-obvious showed up. A miss hot-spot at the same block position across many requests looks identical on the way in, no matter which of three completely different things is causing it.

The first is Chen's case: a stable template with a variable field sitting inside it. The second is a cache that's simply too small, evicting blocks before they get reused, so the content at the miss position is *identical* every time and still misses. The third is traffic that has no shared prefix at all, which is what most consumer chat traffic looks like, and there is nothing to fix.

Same symptom, three different answers. Restructure the prompt. Add capacity. Do nothing.

Telling them apart means looking at the actual content at the miss position across every affected request. If the content differs every time inside an otherwise stable wrapper, it's a variable field. If it's identical and still missing, it's capacity. If there's no stable wrapper to speak of, those are just different prompts.

## Naming the culprit

Knowing block 3 is the problem is not the same as knowing what's *in* block 3. Closing that gap turned out to be the most interesting part of the whole project.

Given every request that first missed at a position, detokenize those blocks and fold them down to their longest common prefix and longest common suffix. What's left in the middle is the varying span:

```
'{"sid":"a3f1e8d2-9c10-...","region":"us-east-1"}'
'{"sid":"b7c2d9e4-1a52-...","region":"us-east-1"}'
 └──── common prefix ────┘└─ span ─┘└─ suffix ──┘
```

The fold matters more than it looks. Diffing two prompts pairwise finds *a* difference. Folding over the whole miss set finds the *minimal* span that explains every miss at that position, which is the thing actually worth telling someone to move.

Two details took longer than expected. First, the minimal span is the right unit for evidence but the wrong one for identification: two ISO timestamps differing only in minutes reduce to two digits, and "integer" is a much worse diagnosis than "timestamp". So the span widens back out to its enclosing field before being classified. Second, a UUID tokenizes to roughly twenty tokens and doesn't fit in whatever remains of a 16-token block, so mining the block alone yields half a UUID, which classifies as freeform text. The field has to be completed from the following blocks.

There was also one design decision I got wrong first and want to flag, because the wrong version was the tempting one. If you hand the tool a tokenizer that doesn't match the corpus, some blocks can't be decoded. The obvious fix is to substitute a placeholder and carry on. That is worse than crashing: identical placeholders across every failing block fold down to "the content here is identical", which is the *capacity* diagnosis, so the tool would have confidently told you to buy more GPU memory on the strength of a decoding bug. It now counts the failures, says which tokenizer it suspects, and reports those positions with no text attribution at all. Graceful degradation has to degrade to "I don't know", never to a confident wrong answer.

## Testing it against real traffic

I ran the tool, unmodified, against three real corpora: two chat datasets (WildChat, LMSys-Chat) and one batch-eval dataset (MMLU, 5-shot).

The chat corpora both showed the same pattern. Misses cluster at the very first block of nearly every request, because different users share no common prefix at all, and the only reuse available is within a single conversation. With text attribution on, the tool prints the actual prompts it's looking at and says there's no shared template here, nothing to preserve. That's a negative result and it's the correct one. A tool that found a culprit in every corpus you pointed it at would not be worth much.

MMLU showed the opposite shape. Every subject shares a fixed 5-example preamble across all of its questions, so the cache hits cleanly through that preamble and misses once, at a block position specific to that subject, right where the actual question begins. Attribution shows the question text at that block, which is what makes the shape legible rather than just a number: block 17 is where this subject's preamble ends.

Same tool, no configuration change between runs, three corpora, three correctly identified shapes.

For the Chen case itself I generate a corpus with known ground truth, two tenants sharing a system prompt where one of them injects a session UUID mid-prompt. The injected field is constructed to land in block 3. The tool, told nothing about it, reports:

```
by tenant:
  acme      97.5%  (40 req, 117/120 blk)
  widgets   50.4%  (40 req, 120/238 blk)

divergent positions for tenant=widgets:
  block   3     40 miss  (100.0% unique — unique content per request)
    culprit: '483bd99b-f1cb-69ce-21a7-b26f60e279f4' at char 45 of the block (uuid, 40 distinct values)
    template: ' sentences.\nSession metadata: {"session_id":"' … ''
    → move this uuid field out of the shared prefix (into the user message or
      request metadata) so the template above it stays cacheable.
```

## Catching it before it ships

Everything above is retrospective. It needs a traffic trace, which means the damage is already done and you're reading the autopsy.

But most of what Chen hit is visible in the template alone. If a variable field sits at block *k*, then blocks *k* through the end can never be reused across requests with different values. That's not an estimate about your traffic, it's a consequence of chaining each block hash to its parent. So you can check it statically, in CI, with no trace and no GPU:

```
$ prefixlens lint prompts/support_agent.txt --tokenizer tiktoken:cl100k_base

  178 tokens ≈ 11 blocks; 1 cacheable today

  [HIGH] session_id — block 1 (token 30, char 159); 10/11 blocks unreachable
      → move session_id out of the shared prefix. It sits in block 1, so 10 of 11
        blocks can never be reused across requests with different values.
  [ok] user_question — block 11 (token 180, char 793); 0/11 blocks unreachable
      → in the trailing partial block, which the engine never caches. Harmless.

  moving all 2 movable fields to the tail recovers ~9 of 11 blocks per request
  (1 → 10 cacheable).
$ echo $?
1
```

A few things fall out of the mechanism rather than out of taste. Severity is about position, not content: a field in block 0 kills the whole prompt, a field in the last complete block has nowhere later to go, and a field past the final block boundary costs nothing at all because the engine only hashes complete blocks. Only the earliest field really matters, since everything after it is already poisoned, though it still has to move or it just becomes the new earliest problem.

The two numbers lean in deliberately opposite directions. "Cacheable today" assumes a value differs from its first character, so it's a floor and your real cache can only beat it. "Recovers ~9" assumes the relocated fields land in the very last block, so it's a ceiling. The linter should never promise reuse you won't get, and never make a problem look cheaper to fix than it is.

I checked that against the simulator rather than trusting it, and the first version of that test failed: 6 blocks measured against 5 predicted. The linter was right and my test was wrong. The fake session IDs I'd generated all began with the same twenty characters, so they diverged later than the field started and the cache did better than predicted. Exactly the direction the floor is supposed to err in, but I only knew that because the check existed.

## The tool

```
pip install prefixlens
```

Four commands. `analyze` for the corpus-wide report, `explain` for one request's block-by-block trace plus its own value at the divergent field, `lint` for the static template check, and `validate` to check the simulator against a real vLLM `/metrics` scrape before trusting anything it says. Text attribution needs a tokenizer, which is an optional extra: `pip install 'prefixlens[tiktoken]'`. Without one, everything still works at block granularity.

It runs on CPU. There's no GPU in the loop anywhere, because none of this needs to run the model, only to replay what the cache would have done.

## What it doesn't do yet

It won't tell you what a restructuring would actually buy you on *your* traffic. Per template, the arithmetic is exact, so `lint` gives you a real number. Across a real workload, that becomes a counterfactual simulation and a projected lift, and I'd rather not publish that number until I can defend how it was computed.

It's also calibrated against vLLM specifically. SGLang and TRT-LLM use different radix and block semantics, and parity there is mechanical work I haven't done.

Worth noting that vLLM has an [in-tree offline analyzer](https://github.com/vllm-project/vllm/issues/47993) in progress, which will have exact access to the engine's own hashing. That's an advantage no external tool can match, and I don't intend to compete with it. The attribution layer, the per-request explain, and the static linting are deliberately a layer above the substrate.

## Closing thought

Building this reinforced something I didn't expect going in: moving from backend infrastructure into AI systems isn't mostly about learning new things. Multi-tenant cache debugging, attributing a bad aggregate number back to a specific cause, telling a data problem apart from a capacity problem, none of that is new. It's the same instinct, pointed at a newer kind of cache.

The one genuinely new reflex was distrusting my own output. A diagnostic that guesses confidently is worse than one that crashes, and most of the real work above was building the checks that would catch me being wrong: ground-truth corpora, the simulator cross-check, and a tool that says "I don't know" when it can't decode what it's looking at.

The tool is open source. If you have real, anonymized traces from a multi-tenant deployment, try running it against them, that's the fastest way to find where it breaks.

[github.com/starparvinai/prefixlens](https://github.com/starparvinai/prefixlens)
