FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 MPLBACKEND=Agg
WORKDIR /srv
# Fetch official wheels through the image builder, then install offline with hashes.
# wheels.lock.json records the source URL, version and digest of every dependency.
ADD https://d2ol7oe51mr4n9.cloudfront.net/user_3Ez4ixNq2W381ZBQXmZ82gFPu9g/f2491b3c-7de1-4618-9128-1be0b8d2be3d.tar /opt/wheels.tar
COPY requirements.lock ./requirements.lock
RUN echo 'ded9580ec6403c461a1bb424ce9164ee37e7ab79f8035663370c737379bd25ed  /opt/wheels.tar' | sha256sum -c - \
    && mkdir -p /opt/wheels && tar -xf /opt/wheels.tar -C /opt/wheels \
    && python -m pip install --no-cache-dir --no-index --find-links=/opt/wheels --require-hashes -r requirements.lock \
    && python -m pip check \
    && useradd --create-home --uid 10001 helix
# Parent synchronization copies the reviewed runner into this build context.
COPY inference/hosted/ ./inference/hosted/
COPY requirements.txt ./requirements.txt
COPY server.py ./server.py
USER helix
EXPOSE 8080
CMD ["python", "server.py"]
