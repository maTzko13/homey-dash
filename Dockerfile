# homey-dash: Gateway (Python-Standardbibliothek) und Web-Oberflaeche in einem Image
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 HOMEY_DASH_DATA=/data HOMEY_DASH_WEB=/app/web
COPY gateway /app/gateway
COPY web /app/web
USER 65534:65534
EXPOSE 8080
VOLUME /data
HEALTHCHECK --interval=60s --timeout=5s CMD python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/healthz', timeout=4)"
ENTRYPOINT ["python3", "/app/gateway/gateway.py"]
CMD ["serve"]
