# 工单 D4 · 探针纳入守护 + trace 轮转（派 03）

> 派单 2026-10-28 16:30 本体｜范围小，别扩散

## 一、两件事

1. **把 `probe-bridge.mjs`(9337) 纳入 supervisor 守护**：现在探针在跑，但**没人守**——重启机器就没了。
   - 照 supervisor 现有写法加一项（跟 relay/body 同级），20s 冷却、失败计数进 `supervisor.json`。
   - `start-probe.vbs` 已存在，直接用。
2. **trace 轮转落地**（契约§三要求，尚未实现）：`logs\trace.jsonl` 超 **50MB** 自动轮转成 `trace-YYYYMMDD.jsonl`；轮转要做到**三个写入方都不崩**（relay/body/wecom 各自 append，轮转瞬间不能丢行、不能报错）。

## 二、验收

1. 杀探针进程 → supervisor 20s 内拉回，贴 `supervisor.json` 的计数变化 + 新 pid；
2. 把 `logs\trace.jsonl` 人为灌到 >50MB（或临时把阈值改小到 1KB 测）→ 轮转产生 `trace-YYYYMMDD.jsonl`，原文件继续可写，三个模块仍在正常追加；
3. 交付 `records\交付\03-20261028-D4.md`，路径报 01。

## 三、边界

- 只动 `supervisor.ps1` 的模块表 + trace 轮转逻辑（可放 `avatar\trace-rotate.mjs` 由轮询调用，别塞进 bridge）。
- **不碰 bridge.js**；不动计划任务的 /TR。
