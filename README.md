# Funding Lens

只读资金费率看板，用于比较以下市场从各标的 Binance 上线时刻起的累计资金费率：

- CXMT：Binance、Hyperliquid `xyz:CXMT`
- UNITREE：Binance、Hyperliquid `xyz:UNITREE`、`para:UNITREE`

看板展示累计正资金费率、累计负资金费率和净资金费率，并按中国 A 股交易时段与非交易时段拆分。所有记录以资金费率结算时间戳归类，不涉及复权、除权除息、TVWAP 或 A 股行情计算。

## 数据与更新

- Binance：`GET /fapi/v1/fundingRate`
- Hyperliquid：`POST /info`，请求类型 `fundingHistory`
- 浏览器打开页面时优先直连官方 API。
- GitHub Actions 每 15 分钟采集一次；出现新结算记录时把 `site/data/funding.json` 持久化回仓库并重新发布。
- 官方 API 暂时不可用时按单一来源回退到最近成功快照，不影响其他来源继续更新。
- 页面只读，没有交易、下单、钱包连接或管理入口。

## GitHub 上的完整服务结构

- `scripts/build_snapshot.py`：采集、清洗、A 股时段归类和累计计算。
- `site/data/funding.json`：仓库内持久化的数据快照。
- `site/`：展示页面、样式、交互与公开配置。
- `.github/workflows/pages.yml`：定时采集、数据入库和 GitHub Pages 发布。

GitHub Pages 不运行常驻 Python/FastAPI 进程，因此定时采集由 GitHub Actions 承担；整套采集、存储、配置和展示代码仍全部保存在同一 GitHub 仓库中。

## A 股时段口径

- 交易时段：09:15–09:25、09:30–11:30、13:00–14:57、14:57–15:00
- 非交易时段：09:25–09:30、11:30–13:00、15:00–次日 09:15、周末及 2026 年官方休市日
- 时区：Asia/Shanghai（UTC+8）

## 本地预览

在仓库根目录运行：

```powershell
python scripts/build_snapshot.py
python -m http.server 4173 --directory site
```

然后访问 `http://127.0.0.1:4173/`。

## 发布

仓库采用 GitHub Actions 自定义 Pages 工作流。仓库必须在 Settings → Pages → Build and deployment 中选择 **GitHub Actions**。推送到 `main` 后自动发布；定时任务会持续刷新静态快照。
