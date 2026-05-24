const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const axios = require('axios');
const mongoose = require('mongoose'); // Thêm thư viện kết nối Database

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');
const upload = multer({ dest: 'uploads/' });

// 1. KẾT NỐI DATABASE MONGO DB ATLAS CỦA TIẾN
const MONGO_URI = "mongodb+srv://tienbuicong586_db_user:WVsSnsObWtGxRPZ4@cluster0.vf5dq6j.mongodb.net/?appName=Cluster0"; 
mongoose.connect(MONGO_URI)
  .then(() => console.log("👉 Đã kết nối thành công tới Database đám mây!"))
  .catch(err => console.error("❌ Lỗi kết nối Database:", err));

// Định nghĩa cấu trúc bảng lưu lượt dùng theo IP
const UserUsageSchema = new mongoose.Schema({
    ip: String,
    count: { type: Number, default: 0 },
    lastUsed: { type: Date, default: Date.now }
});
const UserUsage = mongoose.model('UserUsage', UserUsageSchema);

const AI_API_URL = 'https://api.piapi.ai/api/v1/task';
const AI_API_KEY = process.env.PIAPI_KEY || 'app-QY3gKj7bYidbCgRkZ0P2q7vW';

const imageToBase64 = (filePath) => {
    const ext = path.extname(filePath).replace('.', '').toLowerCase();
    const base64 = fs.readFileSync(filePath, { encoding: 'base64' });
    return `data:image/${ext === 'jpg' || ext === 'jpeg' ? 'jpeg' : 'png'};base64,${base64}`;
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Hàm lấy IP thật của người dùng khi chạy trên Render
function getClientIp(req) {
    return req.headers['x-forwarded-for'] || req.socket.remoteAddress;
}

// 2. API XỬ LÝ GHÉP MẶT (ĐÃ THÊM TÍNH NĂNG ĐẾM LƯỢT CHỐNG SPAM)
app.post('/api/swap-face', upload.single('swap_image'), async (req, res) => {
    let userImagePath = req.file ? req.file.path : null;
    const userIp = getClientIp(req);
    
    try {
        if (!userImagePath) return res.json({ success: false, error: "Thiếu ảnh!" });

        // --- ĐOẠN KIỂM TRA GIỚI HẠN LƯỢT DÙNG ---
        let userRecord = await UserUsage.findOne({ ip: userIp });
        const today = new Date().toDateString();

        if (userRecord) {
            // Nếu chuyển sang ngày mới thì reset số lượt về 0
            if (new Date(userRecord.lastUsed).toDateString() !== today) {
                userRecord.count = 0;
            }
            
            // Nếu đã dùng quá 3 lần trong ngày thì chặn ngay, xóa ảnh tạm để tránh rác server
            if (userRecord.count >= 3) {
                if (userImagePath && fs.existsSync(userImagePath)) fs.unlinkSync(userImagePath);
                return res.status(429).json({ 
                    success: false, 
                    error: "Bạn đã hết 3 lượt thử miễn phí hôm nay! Vui lòng quay lại vào ngày mai." 
                });
            }
        } else {
            // Nếu IP này lần đầu tiên truy cập web
            userRecord = new UserUsage({ ip: userIp });
        }
        // ----------------------------------------

        const vest = req.body.vest_type || 'vest-den';
        const templatePath = path.join(__dirname, `${vest}.png`);

        if (!fs.existsSync(templatePath)) throw new Error(`Thiếu file mẫu: ${vest}.png`);

        const taskPayload = {
            model: "Qubico/image-toolkit",
            task_type: "face-swap",
            input: {
                swap_image: imageToBase64(userImagePath),
                target_image: imageToBase64(templatePath)
            }
        };

        const createRes = await axios.post(AI_API_URL, taskPayload, {
            headers: { 'x-api-key': AI_API_KEY, 'Content-Type': 'application/json' }
        });

        const taskId = createRes.data?.data?.task_id;
        if (!taskId) throw new Error("Lỗi tạo Task.");

        let aiImageUrl = '';
        for (let i = 0; i < 20; i++) {
            await sleep(3000);
            const fetchRes = await axios.get(`${AI_API_URL}/${taskId}`, { headers: { 'x-api-key': AI_API_KEY } });
            const status = fetchRes.data?.data?.status;
            
            if (status === 'completed') {
                const output = fetchRes.data.data.output;
                aiImageUrl = output?.image_url || output?.result || output?.image;
                break;
            } else if (status === 'failed') throw new Error("AI xử lý thất bại.");
        }

        // Xóa ảnh gốc của user ngay sau khi xử lý xong để giải phóng dung lượng
        if (userImagePath && fs.existsSync(userImagePath)) fs.unlinkSync(userImagePath);
        if (!aiImageUrl) throw new Error("Quá thời gian chờ.");

        // --- CỘNG THÊM 1 LƯỢT DÙNG VÀO DATABASE NẾU THÀNH CÔNG ---
        userRecord.count += 1;
        userRecord.lastUsed = new Date();
        await userRecord.save();
        // --------------------------------------------------------

        // Trả link trực tiếp cho trình duyệt
        res.json({ success: true, imageUrl: aiImageUrl });

    } catch (e) {
        if (userImagePath && fs.existsSync(userImagePath)) fs.unlinkSync(userImagePath);
        res.json({ success: false, error: e.message });
    }
});

app.listen(PORT, () => console.log(`🚀 Server chạy port ${PORT}`));