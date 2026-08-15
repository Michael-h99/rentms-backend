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
| Auth               | JWT (access + refresh tokens)              |
| Payments           | Paystack (Mobile Money & Card)             |
| Email              | Resend                                     |
| Push Notifications | Web Push API                               |
| File Uploads       | Multer                                     |
| Real-time          | Socket.io                                  |
| Hosting (Frontend) | Vercel                                     |
| Hosting (Backend)  | Render                                     |

---

## ✨ Features

### Landlord Portal

- Dashboard with stats (plazas, tenants, revenue, maintenance)
- Plaza management with image uploads
- Tenant management via invite codes
- Rent collection via Paystack (Mobile Money & Card), with automated PDF receipts
- Payment tracking and history
- Maintenance request management
- Group messaging with tenants
- Announcements and notifications
- Reports and analytics
- Profile management

### Tenant Portal

- Dashboard with lease overview
- Pay rent online via Paystack (Mobile Money & Card)
- Payment history and downloadable receipts
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
# Server
PORT=5000
NODE_ENV=development
BASE_URL=https://rentms-backend-5.onrender.com
FRONTEND_URL=https://rentms-frontend-rust.vercel.app

# Database (Aiven MySQL)
DB_HOST=your_mysql_host
DB_PORT=your_mysql_port
DB_USER=your_db_user
DB_PASSWORD=your_db_password
DB_NAME=defaultdb

# JWT
JWT_SECRET=your_jwt_secret
JWT_EXPIRES_IN=1d
JWT_REFRESH_SECRET=your_refresh_secret
JWT_REFRESH_EXPIRES_IN=7d

# Email (Resend)
RESEND_API_KEY=your_resend_api_key
EMAIL_FROM=your_verified_sender_email
CONTACT_EMAIL=where_contact_form_messages_should_go

# Push Notifications
VAPID_PUBLIC_KEY=your_vapid_public_key
VAPID_PRIVATE_KEY=your_vapid_private_key

# Paystack
PAYSTACK_SECRET_KEY=sk_test_or_live_key
PAYSTACK_PUBLIC_KEY=pk_test_or_live_key

# Misc
RECEIPTS_PATH=./receipts
MAX_FILE_SIZE_MB=10
SEED_PASSWORD=only_used_by_the_db_seed_script
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
├── services/       # Payment, email, notification services
├── utils/          # DB, error handling, pagination
└── app.js          # Entry point
```

---

## 🔐 Default Admin Account

> ⚠️ **Removed from this README.** Publishing a hardcoded email/password in a public repository is a real security risk — anyone reading this file could use it. If you need a demo admin account for evaluation purposes, create one manually after deployment and share the credentials privately (email, not GitHub), not in version control.

---

## 👨‍💻 Author

Michael Kofi Sarpong-Duah
BSc Software Engineering — Final Year Project
Ghana Communication Technology University (GCTU)

---

## 📄 License

This project is for academic purposes.
