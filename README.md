# Cloud SQL Private Connection Tester (Cloud Run)

Repository ini berisi aplikasi website sederhana berbasis Node.js & Express untuk mengetes koneksi private (Private IP) antara **Google Cloud Run** dan **Google Cloud SQL** (baik PostgreSQL maupun MySQL).

Aplikasi ini memiliki halaman dashboard interaktif modern untuk memantau status koneksi, menampilkan parameter konfigurasi database yang sedang aktif (secara aman/dimasker), dan dilengkapi **diagnostics terminal console** untuk menampilkan error log secara detail apabila koneksi gagal.

---

## Fitur Utama
1. **Multi-Database Support**: Mendukung PostgreSQL dan MySQL.
2. **Ping Test (Read Test)**: Menjalankan kueri `SELECT NOW()` untuk mengetes koneksi dasar dan mengukur latensi.
3. **Full Write Lifecycle Test (CRUD Test)**: Membuat tabel dinamis secara temporer, memasukkan record baru, membaca kembali data tersebut, dan menghapus kembali tabel tersebut untuk memastikan akses write berfungsi.
4. **VPC Network Diagnostics**: Menangkap error stack trace, error code, dan petunjuk kegagalan jaringan secara real-time untuk mempercepat proses debugging konfigurasi VPC/Subnet.

---

## Konfigurasi Environment Variables
Aplikasi membaca kredensial database dari variabel lingkungan berikut:

| Variabel | Deskripsi | Contoh PostgreSQL | Contoh MySQL | Contoh SQL Server (MSSQL) |
|---|---|---|---|---|
| `DB_TYPE` | Jenis database (`postgres`, `mysql`, `mssql`, `sqlsrv`) | `postgres` | `mysql` | `mssql` |
| `DB_HOST` | **Private IP** dari Google Cloud SQL | `10.84.0.3` | `10.84.0.3` | `10.84.0.3` |
| `DB_PORT` | Port database (default `5432` / `3306` / `1433`) | `5432` | `3306` | `1433` |
| `DB_USER` | Username database | `postgres` | `root` | `sqlserver` |
| `DB_PASS` | Password database | `password_anda` | `password_anda` | `password_anda` |
| `DB_NAME` | Nama database | `postgres` | `testdb` | `master` |

---

## 1. Menjalankan Secara Lokal (Local Test)

Sebelum dideploy ke Cloud Run, Anda dapat mengetesnya terlebih dahulu di laptop Anda (memerlukan Node.js):

1. **Instal Dependensi**:
   ```bash
   npm install
   ```

2. **Buat File Konfigurasi `.env`**:
   Buat file bernama `.env` di folder root project:
   ```env
   DB_TYPE=postgres
   DB_HOST=127.0.0.1
   DB_PORT=5432
   DB_USER=postgres
   DB_PASS=mysecretpassword
   DB_NAME=postgres
   ```

3. **Jalankan Aplikasi**:
   ```bash
   npm start
   ```
   Buka `http://localhost:8080` di browser Anda.

---

## 2. Deploy ke Google Cloud Run

Agar Cloud Run dapat terhubung ke Private IP Cloud SQL, Anda harus membuat jembatan jaringan menggunakan **Serverless VPC Access Connector** atau menggunakan fitur baru **Direct VPC Egress**.

Berikut adalah langkah-langkah deploy-nya:

### Langkah A: Build dan Push Container Image ke Artifact Registry

1. **Konfigurasi gcloud CLI**:
   Pastikan Anda sudah login ke akun GCP dan memilih project yang benar:
   ```bash
   gcloud auth login
   gcloud config set project ID_PROJECT_ANDA
   ```

2. **Buat Repositori Artifact Registry (jika belum ada)**:
   ```bash
   gcloud artifacts repositories create my-test-repo \
       --repository-format=docker \
       --location=asia-southeast2 \
       --description="Docker repository"
   ```
   *(Sesuaikan location ke wilayah Anda, misal `asia-southeast2` untuk Jakarta).*

3. **Build Image menggunakan Cloud Build**:
   Kirimkan project ke Cloud Build untuk membuat image Docker secara otomatis di cloud:
   ```bash
   gcloud builds submit --tag asia-southeast2-docker.pkg.dev/ID_PROJECT_ANDA/my-test-repo/db-tester:latest
   ```

### Langkah B: Konfigurasi Jaringan Private (VPC)

#### Pilihan 1: Menggunakan Direct VPC Egress (Direkomendasikan - Lebih Cepat & Hemat)
Fitur baru di Cloud Run untuk mengirim semua trafik keluar langsung ke Subnet VPC:
- Subnet tersebut harus berada di VPC yang sama dengan Cloud SQL (atau terhubung melalui VPC Peering/VPN).
- Pastikan subnet tersebut memiliki IP Range yang cukup.

#### Pilihan 2: Menggunakan Serverless VPC Access Connector
Jika Anda menggunakan metode lama:
1. Buat Serverless VPC Access Connector di konsol Google Cloud pada menu **VPC Network > Serverless VPC Access**.
2. Berikan nama (misal: `sql-connector`), pilih region yang sama dengan Cloud Run & Cloud SQL, dan tentukan range IP kosong (misal: `10.8.0.0/28`).

### Langkah C: Deploy Container ke Cloud Run

Jalankan perintah berikut untuk mendeploy aplikasi ke Cloud Run dengan mengaktifkan koneksi VPC private:

#### Jika menggunakan Pilihan 1 (Direct VPC Egress):
```bash
gcloud run deploy cloud-sql-tester \
    --image=asia-southeast2-docker.pkg.dev/ID_PROJECT_ANDA/my-test-repo/db-tester:latest \
    --region=asia-southeast2 \
    --network=NAMA_VPC_ANDA \
    --subnet=NAMA_SUBNET_VPC_ANDA \
    --vpc-egress=all-traffic \
    --set-env-vars="DB_TYPE=postgres,DB_HOST=PRIVATE_IP_SQL_ANDA,DB_PORT=5432,DB_USER=postgres,DB_PASS=PASSWORD_SQL_ANDA,DB_NAME=NAMA_DATABASE" \
    --allow-unauthenticated
```

#### Jika menggunakan Pilihan 2 (Serverless VPC Access Connector):
```bash
gcloud run deploy cloud-sql-tester \
    --image=asia-southeast2-docker.pkg.dev/ID_PROJECT_ANDA/my-test-repo/db-tester:latest \
    --region=asia-southeast2 \
    --vpc-connector=sql-connector \
    --vpc-egress=all-traffic \
    --set-env-vars="DB_TYPE=postgres,DB_HOST=PRIVATE_IP_SQL_ANDA,DB_PORT=5432,DB_USER=postgres,DB_PASS=PASSWORD_SQL_ANDA,DB_NAME=NAMA_DATABASE" \
    --allow-unauthenticated
```

> [!IMPORTANT]
> - Ganti `ID_PROJECT_ANDA`, `NAMA_VPC_ANDA`, `NAMA_SUBNET_VPC_ANDA`, `PRIVATE_IP_SQL_ANDA`, `PASSWORD_SQL_ANDA`, dll., sesuai dengan data resource GCP Anda.
> - `--vpc-egress=all-traffic` wajib diatur agar request koneksi ke IP Private SQL dilewatkan melalui VPC Anda, bukan jaringan publik internet.

---

## 3. Cara Menguji Koneksi Private

Setelah deployment selesai, buka URL Cloud Run yang diberikan di browser Anda.

1. **Lihat Status Awal**: Halaman akan memuat status secara otomatis. Jika environment variables telah dimasukkan dengan benar pada saat deploy, aplikasi akan langsung mencoba menghubungkan diri.
2. **Ping Test**: Klik tombol **Run Ping Connection (Read)**. Jika berhasil, Anda akan melihat teks sukses hijau dengan waktu query saat ini dan versi database.
3. **Write Test**: Klik tombol **Run Read/Write Lifecycle**. Ini berguna untuk memastikan bahwa user database Anda bukan hanya bisa melakukan koneksi (read), tapi juga memiliki hak akses DDL/DML untuk menulis data (berguna untuk migrasi aplikasi backend).
4. **Analisis Error**: Jika status berwarna merah (Error), lihat panel **diagnostics_terminal.sh**.
   - Jika error berupa `ETIMEDOUT` atau `timeout`, artinya rute jaringan terblokir (VPC Connector belum terpasang dengan benar, atau Firewall Rules di VPC memblokir akses ke port port database 5432/3306).
   - Jika error berupa `password authentication failed` atau `Access denied for user`, artinya rute jaringan sudah aman dan terhubung secara private, namun kredensial username/password database yang Anda masukkan salah.
