# Kế hoạch tổng thể: Sửa toàn bộ lỗi đường UMP 774

Tài liệu này tổng hợp toàn bộ các vấn đề được phát hiện qua kiểm tra tĩnh mã nguồn trên đường **UMP 774** ([`src/inject.js`](file:///home/dh6k/Documents/personal_projects/ytspoofingstream_v3/src/inject.js) & [`src/background.js`](file:///home/dh6k/Documents/personal_projects/ytspoofingstream_v3/src/background.js)) và các bước triển khai sửa chữa, kiểm thử, đóng gói.

---

## Tổng quan 2 đường UMP 774 hiện có
1. **Đường chính (`UmpMseController774` — dùng cho `HYBRID_HQ` và `TV_HEADLESS`)**: Tự gửi `POST` protobuf SABR (`f40=1` audio-only) tới `serverAbrStreamingUrl` của `TVHTML5`, bóc tách (`demuxUmp774`) và nạp Opus 774 vào `MediaSource` của `StudioEngine774`.
2. **Đường phụ (`sabrRewrite` — dùng cho chế độ `TV_RELAY`)**: Chặn request SABR của trình phát YouTube WEB, viết đè `itag 251 -> 774` và kiểm tra phản hồi bằng `ytssInspectUmpBytes`.

---

## Danh sách các hạng mục sửa lỗi

### Hạng mục 1: Lọc `only774` đồng nhất trên cả Chromium và Firefox (`src/inject.js:1130-1135`)
- **Vấn đề**: Trên `!IS_FIREFOX`, format `774` không có `url`/`_directUrl` và cũng không có `completeTvContext` (`serverAbrStreamingUrl` + `ustreamerConfig`) vẫn lọt qua `only774`, khiến `noteTvNative774` không khởi chạy được MSE và kẹt chờ timeout chuyển bài 4s.
- **Giải pháp**: Lọc `only774` cho cả hai nền tảng: yêu cầu có `url || _directUrl || completeTvContext || S.operationMode === OP_MODES.TV_RELAY`.

### Hạng mục 2: Đồng nhất cơ chế bảo vệ `UmpMseController774` cho cả Chromium và Firefox (`src/inject.js:1854-1947`, `2379-2707`, `2851-3078`, `6346`)
- **Vấn đề**: Các cơ chế chống treo và chống tràn bộ đệm đang bị khóa trong `if (IS_FIREFOX)`:
  - `flushQueue`: Trên Chromium `chunk` bị `.shift()` trước `appendBuffer()` và bỏ qua xử lý `QuotaExceededError` (`sourceBuffer.remove`).
  - `pump`: Không có timeout (`AbortController`), không kiểm tra kẹt `sourceBuffer.updating >= 1800ms`, không có backoff `retryAt` khi `!resp.ok`.
  - `_supplyState`, `getSourceHealth`, `_supplyFallback`, `_supplyFailure`, `requestSupply`, `stopSession`, `attachAndLoad`, `stopAndUnmute`: Bị rào `IS_FIREFOX`, khiến Chromium không tự failover/fallback mượt khi luồng UMP lỗi.
- **Giải pháp**: Gỡ rào `IS_FIREFOX` tại các phương thức cung cấp/giám sát luồng UMP MSE để cả Chromium và Firefox đều dùng chung cơ chế bảo vệ timeout, dọn quota, backoff và failover. (Giữ nguyên ngưỡng `cluster gap` nhạy cảm nếu cần hoặc đồng bộ `cluster gap` rõ ràng — theo kế hoạch, giữ nguyên điều kiện `IS_FIREFOX` ở kiểm tra `cluster gap` dòng 2651 để tránh quá nhạy trên Chromium).

### Hạng mục 3: `ensureDecipheredUrl(session)` không lặp vòng chờ `4500ms` (`src/inject.js:2113-2175`)
- **Vấn đề**: Khi `decipherSabrUrl(rawUrl)` thất bại và `_isDecoderReady()` là `false`, `session.decipheredUrl` vẫn `null` nên mỗi nhịp `pump()` kế tiếp lại chờ `4500ms` trong vòng `while`.
- **Giải pháp**: Thêm cờ `session.decipherWaitDone = true` ngay sau lần chờ đầu tiên của session để các nhịp `pump()` sau chỉ kiểm tra nhanh đồng bộ mà không block lặp lại.

### Hạng mục 4: Sửa `demuxUmp774()` đọc đủ `itag` (`field 3` + `field 13`) và không ghi đè mất cluster khi trùng `headerId` (`src/inject.js:2204-2283`)
- **Vấn đề**:
  1. Chỉ đọc `itag` ở `mh.get(3)` mà thiếu fallback sang `mh.get(13)` (`FormatId.f1`).
  2. Lưu `headersById.set(hid, ...)` và cuối hàm mới duyệt `headersById.values()`: nếu 1 response có >= 2 cluster tái sử dụng cùng `headerId`, cluster sau ghi đè mất cluster trước.
- **Giải pháp**:
  - Fallback đọc `mh.get(13)` (`FormatId.f1`) khi `mh.get(3)` vắng mặt hoặc `0`.
  - Lưu thêm danh sách theo thứ tự `orderedHeaders.push(hdr)` và trả về `segments` từ `orderedHeaders`.

### Hạng mục 5: Sửa `sabrRewritePreferredAudio()` sử dụng `pbRebuildFormatIdIfMatched` (`src/inject.js:7582-7695`)
- **Vấn đề**: Sửa tại chỗ nên chỉ ghi đè `lastModified` khi trùng độ dài varint và không cập nhật/xóa `xtags`; hàm `pbRebuildFormatIdIfMatched` bị bỏ thành dead code.
- **Giải pháp**: Dựng lại buffer request bằng `pbParseRawFields` + `pbRebuildFormatIdIfMatched` cho cả `f16` (`preferredAudioFormatIds`) và `f2` (`selectedFormatIds`), truyền thêm `sabrRewrite.xtags || null` từ `ytssMaybeRewriteSabrBody`.

### Hạng mục 6: Sửa `ytssInspectUmpBytes()` dùng `umpReadVarint` (`src/inject.js:7735-7803`)
- **Vấn đề**: Dùng `pbReadVarint` (LEB128) thay vì `umpReadVarint` (UMP prefix varint) khi đọc `partType`/`partSize`, làm sai lệch con trỏ với mọi UMP part `>= 128` byte.
- **Giải pháp**: Thay `pbReadVarint` bằng `umpReadVarint`.

### Hạng mục 7: Bổ sung `POST` và header SABR vào `CORS_RULE_ID` (`src/background.js:755-774`)
- **Vấn đề**: Khi `SabrRedirect` chuyển sang URL CDN không chứa `c=TVHTML5`, request `POST` rơi vào `CORS_RULE_ID` hiện chỉ cho phép `GET, HEAD, OPTIONS`.
- **Giải pháp**: Thêm `POST` vào `Access-Control-Allow-Methods` và bổ sung đầy đủ header SABR vào `Access-Control-Expose-Headers` của `CORS_RULE_ID`.

---

## Kiểm thử & Đóng gói
1. Kiểm tra cú pháp JS toàn bộ các file trong `src/` bằng `node --check`.
2. Viết và chạy bộ kiểm thử tự động `verify_ump774_fixes.js` (kiểm chứng `demuxUmp774`, `ytssInspectUmpBytes`, `sabrRewritePreferredAudio`, `UmpMseController774.flushQueue` khi `QuotaExceededError`).
3. Chạy lại bộ kiểm thử hồi quy `verify_badge_fix.js`.
4. Đóng gói lại extension Firefox bằng `./tools/pack-firefox.sh`.
