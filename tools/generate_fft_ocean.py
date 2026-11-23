#!/usr/bin/env python3
"""
JONSWAP + Tessendorf 2D IFFT Ocean Texture Baker (Google Colab & Local compatible)
Generates 4 seamless, tileable, opaque 512x512 RGB ocean maps into assets/ocean/:
  1. fft_swell_nh.png   (L=42.0m): Medium wind swell & gravity waves (R=gx, G=gy, B=height)
  2. fft_chop_nh.png    (L=13.7m): Short steep wind chop (R=gx, G=gy, B=height)
  3. fft_ripple_nh.png  (L=3.37m): Capillary cat's-paw wind ripples (R=gx, G=gy, B=height)
  4. fft_foam_jwr.png   (L=13.7m): Opaque foam masks (R=Jacobian crest, G=lacy foam web, B=fine micro-foam)

Opaque RGB PNGs guarantee zero premultiplied-alpha corruption across all WebGL/browser PNG decoders.

Axis convention (matches js/world.js):
  +X (u) = wp (cross-wind)
  +Y (v) = wd (downwind propagation direction)
"""
import json
import os
import numpy as np
from PIL import Image

G = 9.81
SIGMA_RHO = 7.4e-5  # surface tension / water density [m^3/s^2]


def periodic_bilinear_sample(arr, u_idx, v_idx):
    """Sample 2D array with periodic wrap-around bilinear interpolation."""
    N = arr.shape[0]
    u0 = np.floor(u_idx).astype(np.int64) % N
    v0 = np.floor(v_idx).astype(np.int64) % N
    u1 = (u0 + 1) % N
    v1 = (v0 + 1) % N
    fu = u_idx - np.floor(u_idx)
    fv = v_idx - np.floor(v_idx)
    return (
        arr[v0, u0] * (1.0 - fu) * (1.0 - fv)
        + arr[v0, u1] * fu * (1.0 - fv)
        + arr[v1, u0] * (1.0 - fu) * fv
        + arr[v1, u1] * fu * fv
    )


def generate_jonswap_cascade(
    N=512,
    L=42.0,
    peak_wavelength=11.0,
    gamma=3.0,
    spread_exp=2.8,
    cross_energy=0.18,
    choppiness=1.15,
    k_min_cut=0.0,
    k_max_cut=1e9,
    seed=42,
    slope_tail_exp=3.45,
):
    """Synthesize one seamless 2D JONSWAP/Tessendorf IFFT ocean cascade."""
    rng = np.random.default_rng(seed)

    # Periodic wavevector grid (kx along cross-wind X, ky along downwind Y)
    freqs = np.fft.fftfreq(N, d=L / N) * (2.0 * np.pi)
    kx, ky = np.meshgrid(freqs, freqs)
    k = np.hypot(kx, ky)
    k_safe = np.where(k > 1e-8, k, 1.0)

    # Gravity + capillary dispersion omega(k)
    omega = np.sqrt(G * k_safe + SIGMA_RHO * (k_safe ** 3))
    domega_dk = (G + 3.0 * SIGMA_RHO * (k_safe ** 2)) / (2.0 * omega)

    # Peak wavenumber & frequency directly matched to cascade physical scale
    k_p = 2.0 * np.pi / max(0.05, float(peak_wavelength))
    omega_p = np.sqrt(G * k_p + SIGMA_RHO * (k_p ** 3))

    # JONSWAP frequency spectrum + Elfouhaily equilibrium high-k tail
    sigma_j = np.where(omega <= omega_p, 0.09, 0.12)
    r_j = np.exp(-((omega - omega_p) ** 2) / (2.0 * (sigma_j ** 2) * (omega_p ** 2) + 1e-12))
    S_omega = (
        (omega_p / (omega + 1e-12)) ** 5.0
        * np.exp(-1.25 * (omega_p / (omega + 1e-12)) ** 4.0)
        * (gamma ** r_j)
    )
    # Blend gentle high-wavenumber slope tail so smaller facets inside each cascade stay rich
    S_tail = 0.045 * ((k_p / k_safe) ** slope_tail_exp) * np.exp(-0.8 * (k_p / k_safe) ** 2)

    # Hasselmann directional spreading around +ky (downwind) with realistic 3D cross-sea
    cos_th = ky / k_safe
    dir_fwd = np.maximum(0.0, 0.5 * (1.0 + cos_th)) ** spread_exp
    dir_cross = (1.0 - 0.50 * (cos_th ** 2)) * cross_energy
    dir_back = (np.maximum(0.0, 0.5 * (1.0 - cos_th)) ** (spread_exp + 1.5)) * 0.07
    D_theta = dir_fwd + dir_cross + dir_back

    # Smooth bandpass filter so cascades complement each other cleanly
    bp = np.ones_like(k)
    if k_min_cut > 0.0:
        bp *= 1.0 - np.exp(-((k / k_min_cut) ** 4))
    if k_max_cut < 1e8:
        bp *= np.exp(-((k / k_max_cut) ** 4))
    bp[0, 0] = 0.0

    dk = 2.0 * np.pi / L
    P_k = (S_omega * (domega_dk / k_safe) + S_tail) * D_theta * bp
    P_k = np.where(k > 1e-8, P_k, 0.0)

    # Random Gaussian complex Fourier amplitudes
    xi_r = rng.standard_normal((N, N))
    xi_i = rng.standard_normal((N, N))
    amp = np.sqrt(0.5 * P_k) * dk
    h_tilde = (xi_r + 1j * xi_i) * amp * (N * N)

    # Height & linear slopes
    h = np.fft.ifft2(h_tilde).real
    gx = np.fft.ifft2(1j * kx * h_tilde).real
    gy = np.fft.ifft2(1j * ky * h_tilde).real

    # Tessendorf horizontal choppy displacement D = (Dx, Dy)
    dx_tilde = -1j * (kx / k_safe) * h_tilde
    dy_tilde = -1j * (ky / k_safe) * h_tilde
    dx_tilde[0, 0] = 0.0
    dy_tilde[0, 0] = 0.0
    Dx = np.fft.ifft2(dx_tilde).real
    Dy = np.fft.ifft2(dy_tilde).real

    # Normalize displacement scale to physically crisp Gerstner crest sharpening
    h_std = np.std(h) + 1e-8
    disp_scale = choppiness * (peak_wavelength * 0.055) / (np.std(Dx) + np.std(Dy) + 1e-8)

    # Exact Jacobian J = (1 + Dxx)(1 + Dyy) - Dxy^2 for crest folding / whitecaps
    Dxx = np.fft.ifft2(1j * kx * dx_tilde).real * disp_scale
    Dyy = np.fft.ifft2(1j * ky * dy_tilde).real * disp_scale
    Dxy = np.fft.ifft2(1j * kx * dy_tilde).real * disp_scale
    J = (1.0 + Dxx) * (1.0 + Dyy) - Dxy * Dxy

    # Fixed-point inverse warp x_src = x - D(x_src) -> sharp pinched crests, wide rounded troughs!
    grid_y, grid_x = np.meshgrid(np.arange(N, dtype=np.float64), np.arange(N, dtype=np.float64), indexing="ij")
    px_per_m = N / L
    sx, sy = grid_x.copy(), grid_y.copy()
    for _ in range(4):
        dxs = periodic_bilinear_sample(Dx, sx, sy) * disp_scale * px_per_m
        dys = periodic_bilinear_sample(Dy, sx, sy) * disp_scale * px_per_m
        sx = grid_x - dxs
        sy = grid_y - dys

    h_w = periodic_bilinear_sample(h, sx, sy)
    gx_w = periodic_bilinear_sample(gx, sx, sy)
    gy_w = periodic_bilinear_sample(gy, sx, sy)
    J_w = periodic_bilinear_sample(J, sx, sy)

    # Stokes 2nd-order crest asymmetry along downwind axis
    h_norm = np.clip(h_w / (2.8 * h_std), -1.0, 1.0)
    crest_sharp = 1.0 + 0.28 * np.maximum(0.0, h_norm)
    gx_w = gx_w * crest_sharp
    gy_w = gy_w * (crest_sharp + 0.16 * np.maximum(0.0, h_norm))

    # Normalize slopes to [-1, 1] using 3.2 * RMS for full 8-bit dynamic range without clipping
    g_rms = np.sqrt(np.mean(gx_w * gx_w + gy_w * gy_w)) + 1e-8
    g_norm_scale = 3.2 * g_rms
    gx_n = np.clip(gx_w / g_norm_scale, -1.0, 1.0)
    gy_n = np.clip(gy_w / g_norm_scale, -1.0, 1.0)

    # Jacobian crest-folding mask (0 in troughs, 1 on breaking sharp crests)
    j_std = np.std(J_w) + 1e-8
    fold = np.clip((1.0 - J_w) / (2.4 * j_std), 0.0, 1.0)
    crest_gate = np.clip((h_norm + 0.05) / 0.75, 0.0, 1.0)
    foam = np.clip(fold * (0.45 + 0.55 * crest_gate) + (crest_gate ** 2.2) * 0.25, 0.0, 1.0)

    return {
        "gx": gx_n,
        "gy": gy_n,
        "h": 0.5 + 0.5 * h_norm,
        "foam": foam,
    }


def generate_lacy_foam_web(N=512, seed=99, freq_scale=1.0):
    """Generate seamless wind-stretched lacy ocean foam filaments via ridged anisotropic FFT noise."""
    rng = np.random.default_rng(seed)
    freqs = np.fft.fftfreq(N, d=1.0 / N)
    kx, ky = np.meshgrid(freqs, freqs)
    # Anisotropic stretch along downwind (+Y) for realistic Langmuir foam streaks
    r1 = np.hypot(kx * 1.50, ky * 0.70)
    r2 = np.hypot(kx * 1.15, ky * 0.92)

    def band_noise(r, f0, bw):
        w = np.exp(-0.5 * ((r - f0 * freq_scale) / (bw * freq_scale)) ** 2)
        w[0, 0] = 0.0
        z = (rng.standard_normal((N, N)) + 1j * rng.standard_normal((N, N))) * w
        out = np.fft.ifft2(z).real
        return out / (np.std(out) + 1e-8)

    n_coarse = band_noise(r1, 8.0, 4.0)
    n_mid = band_noise(r2, 22.0, 10.0)
    n_fine = band_noise(r2, 54.0, 24.0)
    ridge1 = 1.0 - np.clip(np.abs(n_coarse) * 0.85, 0.0, 1.0)
    ridge2 = 1.0 - np.clip(np.abs(n_mid) * 0.92, 0.0, 1.0)
    web = (ridge1 ** 2.0) * 0.55 + (ridge2 ** 2.2) * 0.35 + np.clip(0.5 + 0.30 * n_fine, 0.0, 1.0) * 0.22
    return np.clip((web - 0.26) / 0.68, 0.0, 1.0)


def save_rgb_png(path, r, g, b):
    rgb = np.stack(
        [
            np.clip(np.round(r * 255.0), 0, 255).astype(np.uint8),
            np.clip(np.round(g * 255.0), 0, 255).astype(np.uint8),
            np.clip(np.round(b * 255.0), 0, 255).astype(np.uint8),
        ],
        axis=-1,
    )
    Image.fromarray(rgb, mode="RGB").save(path, optimize=True)


def main():
    out_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets", "ocean")
    os.makedirs(out_dir, exist_ok=True)
    # Remove any legacy RGBA files
    for old in ("fft_swell_nhf.png", "fft_chop_nhf.png", "fft_ripple_n.png"):
        p = os.path.join(out_dir, old)
        if os.path.exists(p):
            os.remove(p)

    N = 512
    print("1/4 Baking Cascade 1: Medium Swell & Gravity Wind Waves (JONSWAP, L=42.0m, lp=10.5m)...")
    c1 = generate_jonswap_cascade(
        N=N, L=42.0, peak_wavelength=10.5, gamma=3.1,
        spread_exp=2.8, cross_energy=0.16, choppiness=1.25,
        k_min_cut=0.22, k_max_cut=3.2, seed=101,
    )
    save_rgb_png(os.path.join(out_dir, "fft_swell_nh.png"), 0.5 + 0.5 * c1["gx"], 0.5 + 0.5 * c1["gy"], c1["h"])

    print("2/4 Baking Cascade 2: Short Steep Wind Chop (JONSWAP, L=13.7m, lp=2.9m)...")
    c2 = generate_jonswap_cascade(
        N=N, L=13.7, peak_wavelength=2.9, gamma=2.4,
        spread_exp=2.2, cross_energy=0.24, choppiness=1.10,
        k_min_cut=0.85, k_max_cut=11.0, seed=202,
    )
    save_rgb_png(os.path.join(out_dir, "fft_chop_nh.png"), 0.5 + 0.5 * c2["gx"], 0.5 + 0.5 * c2["gy"], c2["h"])

    print("3/4 Baking Cascade 3: Capillary Cat's-Paw Ripples (L=3.37m, lp=0.52m)...")
    c3 = generate_jonswap_cascade(
        N=N, L=3.37, peak_wavelength=0.52, gamma=1.7,
        spread_exp=1.8, cross_energy=0.32, choppiness=0.80,
        k_min_cut=4.2, k_max_cut=46.0, seed=404, slope_tail_exp=3.1,
    )
    save_rgb_png(os.path.join(out_dir, "fft_ripple_nh.png"), 0.5 + 0.5 * c3["gx"], 0.5 + 0.5 * c3["gy"], c3["h"])

    print("4/4 Baking Opaque Foam & Jacobian Pack (fft_foam_jwr.png)...")
    foam_web = generate_lacy_foam_web(N=N, seed=303, freq_scale=1.0)
    micro_foam = generate_lacy_foam_web(N=N, seed=505, freq_scale=1.7)
    save_rgb_png(os.path.join(out_dir, "fft_foam_jwr.png"), c1["foam"], foam_web, np.clip(c2["foam"] * 0.45 + micro_foam * 0.65, 0.0, 1.0))

    meta = {
        "resolution": N,
        "format": "opaque-rgb-png",
        "cascades": [
            {"file": "fft_swell_nh.png", "tileMeters": 42.0, "peakWavelength": 10.5},
            {"file": "fft_chop_nh.png", "tileMeters": 13.7, "peakWavelength": 2.9},
            {"file": "fft_ripple_nh.png", "tileMeters": 3.37, "peakWavelength": 0.52},
            {"file": "fft_foam_jwr.png", "tileMeters": 13.7, "channels": "R=jacobian,G=lacyWeb,B=microFoam"},
        ],
    }
    with open(os.path.join(out_dir, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)
    print("Done! Generated opaque RGB ocean textures:")
    for fn in sorted(os.listdir(out_dir)):
        sz = os.path.getsize(os.path.join(out_dir, fn))
        print(f"  {fn}: {sz / 1024:.1f} KB")


if __name__ == "__main__":
    main()
