# RentMS — Property Management System

A full-stack web application for managing rental properties in Ghana. Built as a Final Year Project.

## 🌐 Live Demo

- **Frontend:** https://rentms-frontend-rust.vercel.app
- **Backend API:** https://rentms-backend-5.onrender.com

---

## 🧰 Tech Stack

| Layer              | Technology                                 |
| ------------------ | ------------------------------------------ |
| Frontend           | HTML, CSS, Bootstrap 5, Vanilla JavaScript |
| Backend            | Node.js, Express.js                        |
| Database           | MySQL (Aiven Cloud)                        |
| Auth               | JWT (JSON Web Tokens)                      |
| File Uploads       | Multer                                     |
| Email              | Nodemailer (Gmail SMTP)                    |
| Real-time          | Socket.io                                  |
| Hosting (Frontend) | Vercel                                     |
| Hosting (Backend)  | Render                                     |

---

## ✨ Features

### Landlord Portal

- Dashboard with stats (plazas, tenants, revenue, maintenance)
- Plaza management with image uploads
- Tenant management via invite codes
- Payment tracking and receipts
- Maintenance request management
- Group messaging with tenants
- Announcements and notifications
- Reports and analytics
- Profile management

### Tenant Portal

- Dashboard with lease overview
- Payment history
- Maintenance request submission
- Group chat with landlord
- Notifications
- Profile management

### Admin Portal

- Platform-wide dashboard
- User management (landlords & tenants)
- Plaza and lease oversight
- Payment monitoring
- Maintenance overview
- System health monitoring

---

## 🚀 Getting Started

### Prerequisites

- Node.js v18+
- MySQL database
- Git

### Backend Setup

```bash
# Clone the backend
git clone https://github.com/Michael-h99/rentms-backend.git
cd rentms-backend

# Install dependencies
npm install

# Create .env file
cp .env.example .env
# Fill in your environment variables

# Run the server
node app.js
```

### Environment Variables (Backend)

```env
PORT=5000
DB_HOST=your_mysql_host
DB_PORT=your_mysql_port
DB_USER=your_db_user
DB_PASSWORD=your_db_password
DB_NAME=defaultdb
JWT_SECRET=your_jwt_secret
FRONTEND_URL=https://rentms-frontend-rust.vercel.app
EMAIL_USER=your_gmail@gmail.com
EMAIL_PASS=your_gmail_app_password
```

### Frontend Setup

```bash
# Clone the frontend
git clone https://github.com/Michael-h99/rentms-frontend.git
cd rentms-frontend

# Open in browser or deploy to Vercel
# No build step required — plain HTML/CSS/JS
```

---

## 📁 Project Structure

```
rentms-frontend/
├── Admin/          # Admin portal pages
├── Landlord/       # Landlord portal pages
├── Tenants/        # Tenant portal pages
├── auth/           # Login & register pages
├── css/            # Stylesheets
├── js/             # JavaScript files
└── index.html      # Landing page

rentms-backend/
├── controllers/    # Route handlers
├── middleware/     # Auth, upload, rate limiting
├── routes/         # API route definitions
├── services/       # Notification, email services
├── utils/          # DB, error handling, pagination
└── app.js          # Entry point
```

---

## 🔐 Default Admin Account

```
Email:    admin@rentms.com
Password: Admin@1234
```

> ⚠️ Change this password after first login in production.

---

## 👨‍💻 Author

Michael kofi Sarpong-dua
BSc Computer Science — Final Year Project  
University, Ghana

---

## 📄 License

This project is for academic purposes.
