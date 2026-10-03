# Invoice Risk Review

### *Automated Invoice Screening & Risk Assessment*

<p align="center">
  <img src="examen-logo.png" alt="logo" width="180" />
</p>

> A full-stack platform for automated invoice verification, risk assessment, and human-in-the-loop review.

---

## Project Description

Invoice Risk Review is a full-stack invoice screening and review platform designed to automate invoice verification and risk assessment. The system processes uploaded invoices through OCR-based extraction, deterministic validation, duplicate detection, GST and Tally verification, and OpenAI-powered anomaly analysis. A consolidated 0–100 risk score highlights potentially problematic invoices for manual review. The platform also provides role-based access, reviewer workflows, source-document verification, audit history, and an administrative dashboard.

---

## Sample Request / User Flow

### 01. User Authentication

- User registers or logs in using email and password.
- Backend authenticates the user using JWT.
- Access and actions are controlled based on user role.

### 02. Invoice Submission

- User uploads an invoice through the dashboard.
- Backend validates the uploaded file.
- Invoice metadata and document are stored securely.

### 03. Invoice Processing

- OCR extracts text and document information.
- Extracted fields are normalized into structured invoice data.
- Validation checks verify:
  - Invoice number and date
  - GSTIN structure
  - Tax calculations
  - Invoice totals
  - Line items
  - Duplicate invoices

### 04. External Verification

- GST information is investigated through the configured GST provider.
- Invoice information can be verified against Tally.
- Provider failures are handled through configured fallback mechanisms.

### 05. AI Analysis

- Structured invoice information is sent to OpenAI for anomaly analysis.
- AI findings are validated against a strict response schema.
- AI output contributes signals to the overall risk assessment.

### 06. Risk Assessment

- Validation, duplicate, GST, Tally, and AI signals are consolidated.
- System generates a **0–100 risk score**.
- Potentially high-risk invoices are flagged for manual review.

### 07. Human Review

- Reviewer examines:
  - Extracted invoice data
  - Source document
  - Validation findings
  - GST verification
  - Tally verification
  - AI findings
  - Risk signals
  - Review history
- Reviewer verifies the extracted information.
- Invoice can then be:
  - Approved
  - Rejected
  - Marked as requiring additional information

---

## Tech Stack

### Frontend

![React](https://img.shields.io/badge/React-20232A?logo=react&logoColor=61DAFB)
![Vite](https://img.shields.io/badge/Vite-646CFF?logo=vite&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?logo=javascript&logoColor=black)
![CSS](https://img.shields.io/badge/CSS-1572B6?logo=css3&logoColor=white)

- React 18
- Vite
- JavaScript
- CSS

### Backend

![Node.js](https://img.shields.io/badge/Node.js-339933?logo=node.js&logoColor=white)
![Express](https://img.shields.io/badge/Express-000000?logo=express&logoColor=white)

- Node.js
- Express.js
- REST APIs
- Multer
- Zod

### Database

![MongoDB](https://img.shields.io/badge/MongoDB-47A248?logo=mongodb&logoColor=white)
![Mongoose](https://img.shields.io/badge/Mongoose-880000?logo=mongoose&logoColor=white)

- MongoDB
- Mongoose

### AI & Document Processing

![OpenAI](https://img.shields.io/badge/OpenAI-412991?logo=openai&logoColor=white)

- OpenAI
- OCR.space
- Deterministic invoice extraction
- Duplicate detection

### Verification & Risk

- GSTIN API
- Tally XML integration
- Mock providers for development
- Rule-based validation
- 0–100 risk scoring

### Authentication & Security

- JWT
- bcrypt
- Role-based authorization
- Helmet
- CORS
- Rate limiting
- File type and size validation

### DevOps & Testing

![Docker](https://img.shields.io/badge/Docker-2496ED?logo=docker&logoColor=white)

- Docker
- Docker Compose
- Node.js test suites

---

## Key Capabilities

| Feature | Description |
|---|---|
| **OCR Extraction** | Extracts structured information from uploaded invoices |
| **Invoice Validation** | Validates dates, GSTINs, taxes, totals, and line items |
| **Duplicate Detection** | Identifies potentially duplicate invoices |
| **GST Verification** | Investigates GST information through configured providers |
| **Tally Verification** | Supports Tally-based invoice verification |
| **AI Analysis** | Detects invoice anomalies using OpenAI |
| **Risk Scoring** | Consolidates multiple signals into a 0–100 risk score |
| **Human Review** | Enables reviewers to verify and make final decisions |
| **Role-Based Access** | Supports Marketing, Reviewer, and Admin roles |
| **Audit History** | Maintains review and verification history |

---

## Setup & Start

### Prerequisites

- Node.js 22+
- Docker Desktop
- Docker Compose

### Clone Repository

```bash
git clone <repository-url>
cd <project-directory>
```

### Configure Environment

Create the required environment configuration for the backend.

```env
NODE_ENV=development

MONGO_URI=mongodb://mongo:27017/invoice-risk

JWT_SECRET=your-secret
JWT_ISSUER=invoice-risk
JWT_AUDIENCE=invoice-risk-users

OPENAI_API_KEY=your-key
OCR_API_KEY=your-key

GST_PROVIDER=none
TALLY_PROVIDER=mock
```

Provider integrations can be configured according to the deployment environment.

### Start with Docker

```bash
docker compose up --build
```

### Application

| Service | URL |
|---|---|
| **Frontend** | `http://localhost:5173` |
| **Backend API** | `http://localhost:4000` |
| **MongoDB** | `localhost:27017` |

### Stop Services

```bash
docker compose down
```

### Run Backend Tests

```bash
cd backend
npm test
```

---

## Project Structure

```text
.
├── backend/
│   ├── src/
│   │   ├── models/
│   │   ├── routes/
│   │   ├── services/
│   │   │   ├── ai/
│   │   │   ├── gst/
│   │   │   ├── processing/
│   │   │   ├── risk/
│   │   │   ├── tally/
│   │   │   └── validation/
│   │   ├── app.js
│   │   ├── auth.js
│   │   ├── config.js
│   │   ├── db.js
│   │   └── server.js
│   ├── test/
│   └── Dockerfile
│
├── frontend/
│   ├── src/
│   │   ├── App.jsx
│   │   ├── main.jsx
│   │   ├── phase6.css
│   │   └── styles.css
│   ├── Dockerfile
│   └── vite.config.js
│
├── docker-compose.yml
├── package.json
└── package-lock.json
```

---

