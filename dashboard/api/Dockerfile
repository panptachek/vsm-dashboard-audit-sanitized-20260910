FROM python:3.12-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    libpango-1.0-0 libpangocairo-1.0-0 libgdk-pixbuf-2.0-0 \
    libffi-dev libcairo2 fonts-dejavu-core libreoffice-calc chromium \
    && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /opt/vsm/reports_outgoing /opt/vsm/ops/report_pipeline/report_cache/xlsx /opt/vsm/ops/report_pipeline/report_cache/pdf
RUN pip install --no-cache-dir fastapi uvicorn psycopg2-binary weasyprint python-multipart openpyxl playwright matplotlib pdfplumber python-docx
COPY main.py .
COPY auth.py .
COPY wip_routes.py .
COPY wip_analytics_routes.py .
COPY wip_map_routes.py .
COPY earthworks_routes.py .
COPY reports_routes.py .
COPY report_text_parser.py .
COPY temp_roads_catalog.py .
COPY xlsx_report_adapter.py .
COPY db_admin_routes.py .
COPY pdf/ pdf/
EXPOSE 8090
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8090"]
