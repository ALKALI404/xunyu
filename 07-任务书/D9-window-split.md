# 工单 D9 · 窗口历史分目录 + 零 token 气泡推送（派 03·维护）

> 派单 2026-10-28 16:58 本体｜主人定：**通知不占 DSH token**
> 依赖：D8（workdesk 9340）先跑起来，页面留了「鲟鱼 / DSH」两个标签等你这两个数据源。

## 一、两件事

### 1. 窗口历史分目录（让 UI 能切换浏览两个上下文）

现在窗口历史是 `E:\DeepFish\History\chats\window_*.md` 混在一起。改成按来源分开写：

```
E:\DeepFish\History\window\
  ├ 鲟鱼\2026-10-28.jsonl     ← 跟鲟鱼（本体/QQ）的对话
  └ dsh\2026-10-28.jsonl      ← 跟 DSH 的对话
```

- 一行一条：`{t, from:"主人"|"agent", target:"鲟鱼"|"dsh", text}`；
- **双写期**：老路径 `chats\window_*.md` 继续写（别断），新目录同时写，跑两天确认没问题再停旧；
- 提供只读接口或直接给 workdesk 读（`GET /api/history?target=鲟鱼|dsh&day=YYYY-MM-DD` 由 04 接，你只管落盘格式）。

### 2. 气泡推送（零 token）

给 workdesk 一个本地可调用入口，把「有 N 条可催」显示在对话窗/身体服务上：

- 复用 `body-service` 的 `/say` 或 `/memo`（**不要新起服务**）；
- 加一个薄封装 `GET/POST http://127.0.0.1:9335/notice?text=...&level=info`（若现有 `/memo` 够用就直接用，不用加）；
- **禁止**任何 `session/prompt` 调用；一次性显示，不做弹窗轰炸。

## 二、验收

1. 新目录里能看到今天的 `鲟鱼\*.jsonl` 与 `dsh\*.jsonl`，各贴 2 行；
2. 旧路径仍在写（不回归）；
3. 气泡/备忘显示真实可用：贴一条 curl 与窗口上的效果说明；
4. `grep -r "session/prompt" scripts\` 里**没有**你新加的文件；
5. 交付 `records\交付\03-20261028-D9.md`，路径报 01。

## 三、边界

- 只动 relay 的历史写入 + body-service 的展示接口；**不碰 bridge.js**。
- 不实现推送规则（那是 workdesk 的事），你只提供"能显示"的入口。
- 分流写入必须有失败兜底：新目录写失败时不许丢消息，退回旧路径。
