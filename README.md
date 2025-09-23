# 函稿裡到底藏了多少問題呢？

一個使用 Node.js + Express + Socket.IO 打造的即時投票小遊戲，專為教室情境優化。全班掃描 QRCode 或輸入網址即可立刻投票，並在投票後 1~2 秒內看到全班統計。

## 功能亮點
- ✅ 20 個固定選項，無須登入即可參與
- ✅ 匿名使用者 ID 儲存於 `localStorage`，刷新後仍保持「已投票」狀態
- ✅ 伺服器端阻擋重複投票與非法選項，含簡易 IP 節流
- ✅ Socket.IO 即時廣播統計，行動優先的清新 UI
- ✅ 可選擇啟用 JSON 檔案持久化，部署 Render 亦可運作

## 專案結構
```
.
├─ package.json
├─ server.js
├─ public
│  ├─ index.html
│  ├─ styles.css
│  └─ app.js
└─ README.md
```

## 環境需求
- Node.js 18 或以上
- npm 9 或以上（建議）

## 本機開發流程
1. 安裝套件
   ```bash
   npm install
   ```
2. 啟動開發伺服器（自動重啟）
   ```bash
   npm run dev
   ```
3. 正式執行
   ```bash
   npm start
   ```
4. 預設網址：<http://localhost:3000>

> **提示**：若需在離線測試多台裝置，可將內網網址分享給其他手機，或使用同一臺機器開啟多個瀏覽器視窗。

## 伺服器設定與安全
- 監聽 `process.env.PORT || 3000`，`host` 為 `0.0.0.0`
- 僅接受同源請求，靜態資源由 Express 提供
- 伺服器驗證投票選項必須是 1..20 的整數
- 每個 `userId`（UUID）只能投一次；伺服器端維護投過名單
- 同一 IP 在 2 秒內的重複投票會被丟棄，防止刷票

## JSON 持久化（選用）
預設使用記憶體儲存統計與投票 ID。若想在重啟服務後保留資料，可在啟動時加入環境變數：
```bash
USE_JSON_PERSISTENCE=true npm start
```

- 票數會寫入 `data/votes.json`
- 服務啟動時若檔案存在會自動載入
- 可進一步改寫為資料庫或排程寫入，檔案結構已預留擴充點

## Render 部署指南
1. 將專案推送到 GitHub Repository
2. 登入 Render，新增 **Web Service**
3. 選擇 **以 Git 部署**，綁定包含此專案的 repo
4. 設定 Build / Start 指令：
   - Build Command: `npm install`
   - Start Command: `npm start`
5. Render 會自動注入 `PORT` 環境變數，本專案已遵循該設定
6. Socket.IO 使用預設路徑 `/socket.io`，Render 支援 WebSocket
7. 免費方案可能會休眠，首次喚醒需等待幾秒鐘

> 若要啟用 JSON 持久化，可在 Render 的 **Environment** 區塊加上 `USE_JSON_PERSISTENCE=true`。

## 驗收清單
- [ ] 手機 A 與手機 B 同時打開：任一方投票後，雙方統計 1~2 秒內同步
- [ ] 同一手機刷新頁面仍為「已投狀態」
- [ ] 非法選項（非 1..20）無效
- [ ] 總數與各選項統計正確

## 後續擴充建議
- 加上管理者後台，支援重置統計或切換題目
- 引入資料庫或外部快取（Redis）儲存投票結果
- 建立圖表動畫或顏色漸層，提升視覺效果
- 整合 QR Code 產生器快速分享投票連結

祝投票活動順利，找出函稿裡的所有問題！
