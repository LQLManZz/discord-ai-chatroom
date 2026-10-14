# discord-ai-chatroom

Biến một server Discord thành trung tâm điều phối các AI agent lập trình có sẵn trên máy bạn. **Orchestrator** (Claude Opus qua Claude Code) lập kế hoạch, chia việc cho các **worker** rẻ hơn (Claude Sonnet/Haiku, Gemini qua Antigravity, DeepSeek qua Codex) rồi nghiệm thu. Bạn duyệt kế hoạch và nhận báo cáo ngay trên Discord.

[English](README.md)

## Tính năng

- Vòng **lập kế hoạch → duyệt → thực thi → nghiệm thu**, các task chạy song song theo đồ thị phụ thuộc.
- **Không ghi đè công việc của nhau**: mỗi task sở hữu file riêng, task cùng sửa một file được xếp lần lượt, engine đo ai thực sự sửa file nào và báo xung đột cho Orchestrator; file được sao lưu trước mỗi task.
- **Giao tiếp qua Orchestrator**: hợp đồng chung, gói bàn giao có cấu trúc, yêu cầu/câu hỏi/vướng mắc được Orchestrator xử lý.
- **Hiểu quota**: agent hết quota thì job tạm dừng (không thất bại), lưu tiến trình và tự chạy tiếp sau khi reset (dùng dữ liệu [onWatch](https://github.com/onllm-dev/onwatch) nếu có).
- **Chịu được khởi động lại**: job được lưu ra đĩa và chạy tiếp đúng chỗ.
- **Tự dò agent**: chỉ các CLI có trên máy mới được giao việc.
- Giao diện **Anh / Việt** (`LANGUAGE=en|vi`).

## Yêu cầu

- Node.js **22.13+**
- [Claude Code](https://docs.claude.com/en/docs/claude-code) (`claude`) đã đăng nhập — bắt buộc cho Orchestrator
- Tùy chọn: [Antigravity](https://antigravity.google) (`agy`), [Codex CLI](https://github.com/openai/codex) (`codex`) có provider `deepseek` trong `~/.codex/config.toml`, [onWatch](https://github.com/onllm-dev/onwatch)
- Một server Discord bạn quản lý

## Cài đặt nhanh

```bash
git clone https://github.com/LQLManZz/discord-ai-chatroom.git
cd discord-ai-chatroom
npm install
npm run setup
npm start
```

`npm run setup` hướng dẫn từng bước: tạo bot tại <https://discord.com/developers/applications> (Reset Token, bật **Message Content Intent**), mời bot vào server bằng link được in ra, bật **Developer Mode** để lấy ID kênh lobby và ID của bạn, chọn ngôn ngữ (`vi`) và thư mục workspace. Wizard tự dò các CLI agent, ghi `.env` và chạy `npm run doctor`.

Sau đó gõ `!help` trong kênh lobby. Bot tự dựng các kênh: **🏢 AI HUB** (lobby, `📥-reports`), **📡 MONITORING** (`📊-dashboard`, `📈-quota`, `🩺-health`, `🧾-activity`, `🚨-alerts`) và **📁 WORKSPACES** (mỗi thư mục một kênh, mỗi job một thread).

## Lệnh chính

| Lệnh | |
|---|---|
| `!task <yêu cầu>` / `!task in <thư_mục>: <yêu cầu>` | Giao việc |
| `!revise <góp ý>` · `!approve` · `!cancel` · `!resume [job]` | Điều khiển job |
| `!ask <agent> <câu hỏi>` | Hỏi nhanh một agent |
| `!workspace [đường_dẫn]` · `!autonomy [add\|remove <đường_dẫn>]` | Workspace và quyền |
| `!files` · `!cat` · `!diff` · `!run` · `!agents` · `!model` · `!quota` · `!status` · `!jobs` · `!export` · `!clean` · `!hub` | Công cụ và hệ thống |

Cấu hình đầy đủ: xem [README.md](README.md#configuration) và [.env.example](.env.example).

## Chạy liên tục

- **Windows**: `npm run autostart` — tự chạy khi đăng nhập, ẩn cửa sổ, tự khởi động lại khi crash.
- **macOS / Linux**: dùng trình quản lý tiến trình, ví dụ `pm2 start src/index.js --name ai-chatroom`.

## Bảo mật

Người trong `ALLOWED_USER_IDS` có thể cho agent sửa file trong workspace, và ở thư mục **FULL AUTONOMY** thì chạy được mọi lệnh terminal. Giữ danh sách này ngắn và dùng server riêng tư. Không commit file `.env`.
