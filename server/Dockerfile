FROM python:3.12-alpine
WORKDIR /app
COPY qb_server.py .
ENV QB_DATA=/data QB_PORT=8787 PYTHONUNBUFFERED=1
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8787/api/health || exit 1
USER 1000:1000
CMD ["python", "qb_server.py"]
