<div align="center">

# discord-ai-chatroom

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.13-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![discord.js](https://img.shields.io/badge/discord.js-v14-5865F2?logo=discord&logoColor=white)](https://discord.js.org)

Biến server Discord thành phòng điều khiển cho các AI agent lập trình trên máy bạn.<br>
Orchestrator lập kế hoạch, đội agent rẻ hơn thực hiện, bạn duyệt và nghiệm thu ngay trên Discord.

[Tính năng](#tính-năng) • [Cài đặt](#cài-đặt) • [Sử dụng](#sử-dụng) • [Cấu hình](#cấu-hình) • [English](README.md)

</div>

## Tính năng

- **Một yêu cầu, cả một đội**: Claude Opus (qua [Claude Code](https://docs.claude.com/en/docs/claude-code)) chia yêu cầu thành task và giao cho agent phù hợp nhất về chi phí: Claude Sonnet/Haiku, Gemini (qua Antigravity), DeepSeek (qua Codex).
- **Bạn luôn nắm quyền**: mọi kế hoạch chờ bạn duyệt; muốn sửa thì `!revise`.
- **Agent không ghi đè nhau**: mỗi task sở hữu file riêng, task cùng sửa một file được chạy lần lượt, thay đổi thật được đo và xung đột chuyển về Orchestrator. File được sao lưu trước mỗi task.
- **Giao tiếp qua Orchestrator**: hợp đồng chung, gói bàn giao có cấu trúc, yêu cầu/câu hỏi được Orchestrator xử lý.
- **Hiểu quota**: agent hết quota thì job tạm dừng thay vì thất bại, và tự chạy tiếp sau khi reset.
- **Giám sát sẵn có**: các kênh dashboard, quota, health, activity, alerts được tạo tự động.
- **Dùng những gì bạn có**: tự dò các CLI agent đã cài trên máy.

## Cài đặt

Cần **Node.js 22.13+**, **Claude Code** (`claude`) đã đăng nhập, và một server Discord bạn quản lý. Tùy chọn: [Antigravity](https://antigravity.google) (`agy`), [Codex CLI](https://github.com/openai/codex) có provider `deepseek`, [onWatch](https://github.com/onllm-dev/onwatch).

```bash
git clone https://github.com/LQLManZz/discord-ai-chatroom.git
cd discord-ai-chatroom
npm install
npm run setup
npm start
```

`npm run setup` hỏi ngôn ngữ (chọn `vi`), kiểm tra token bot và in link mời bot, hỏi ID kênh lobby và ID của bạn, tự dò CLI agent, ghi `.env` rồi kiểm tra toàn bộ.

> [!TIP]
> Tạo bot tại <https://discord.com/developers/applications> → **Bot** → **Reset Token**, bật **Message Content Intent**. Để copy ID trong Discord: **Settings → Advanced → Developer Mode**, rồi chuột phải vào kênh hoặc avatar.

Bot tự dựng các kênh quanh lobby: **AI HUB** (lobby, `📥-reports`), **MONITORING** (`📊-dashboard`, `📈-quota`, `🩺-health`, `🧾-activity`, `🚨-alerts`), **WORKSPACES** (mỗi thư mục một kênh, mỗi job một thread). Gõ `!help` để bắt đầu.

Chạy nền: `npm run autostart` trên Windows (tự chạy khi đăng nhập, tự khởi động lại khi crash); macOS/Linux dùng `pm2 start src/index.js --name ai-chatroom`.

## Sử dụng

| Lệnh | Mô tả |
|---|---|
| `!task <yêu cầu>` | Tạo job trong workspace của kênh (ở lobby: workspace mặc định) |
| `!task in <thư_mục>: <yêu cầu>` | Tạo job ở thư mục chỉ định |
| `!revise <góp ý>` · `!approve` · `!cancel` | Điều khiển job của thread hiện tại |
| `!resume [job]` | Chạy lại ngay job đang chờ quota |
| `!ask <agent> <câu hỏi>` | Hỏi nhanh một agent |
| `!workspace [đường_dẫn]` · `!autonomy [add\|remove <đường_dẫn>]` | Workspace và quyền |
| `!files` · `!cat` · `!diff` · `!run` · `!agents` · `!model` · `!quota` · `!status` · `!jobs` · `!export` · `!clean` · `!hub` | Công cụ và hệ thống |

## Cấu hình

Mọi thiết lập nằm trong `.env` (tạo bởi `npm run setup`), danh sách đầy đủ ở [.env.example](.env.example) và [README.md](README.md#configuration). Đổi ngôn ngữ giao diện bằng `LANGUAGE=en|vi`.

> [!WARNING]
> Người trong `ALLOWED_USER_IDS` có thể cho agent sửa file trong workspace, và ở thư mục full autonomy thì chạy được mọi lệnh terminal. Giữ danh sách này ngắn và dùng server riêng tư.

Đóng góp: xem [CONTRIBUTING.md](CONTRIBUTING.md).
