# Plastiq mesh→B-rep reconstruction service. pythonocc-core is conda-forge only, so we
# build on miniforge and create the runtime env from environment.yml.
FROM condaforge/miniforge3:latest

WORKDIR /srv

# Create the conda env (cached unless environment.yml changes).
COPY environment.yml /srv/environment.yml
RUN mamba env create -f /srv/environment.yml && mamba clean -afy

# Linux has no default MLX backend: environment.yml's bare `mlx` (kept as the macOS source of
# truth, where mlx-metal comes with it) ships NO backend on Linux, and app/fidelity.py imports
# mlx.core at import time — without this, uvicorn cannot start in the container. Install the
# CPU backend into the env explicitly (same fix as CI's "Install the MLX Linux CPU backend"
# step in .github/workflows/ci.yml).
RUN /opt/conda/envs/plastiq-reconstruct/bin/pip install "mlx[cpu]"

# Put the env first on PATH so uvicorn/python resolve to it without `conda activate`.
ENV PATH=/opt/conda/envs/plastiq-reconstruct/bin:$PATH

COPY app /srv/app

EXPOSE 8000
# A single worker: OCCT reconstruction is CPU-bound and dispatched to a thread per job.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
