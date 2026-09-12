FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 MPLBACKEND=Agg
WORKDIR /srv
# Parent synchronization copies the reviewed runner into this build context.
COPY inference/hosted/ ./inference/hosted/
COPY requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt \
    && useradd --create-home --uid 10001 helix
COPY server.py ./server.py
USER helix
EXPOSE 8080
CMD ["python", "server.py"]
