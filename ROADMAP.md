# ROADMAP: Парсер аудио & Ритм-игра "Tap Tap Piano"

Этот документ является фундаментальной статической базой проекта (High-Level Vision, Математика и Полная Архитектура). Изменяется только при принципиальном смене вектора проекта.

---

## 1. Концепция и Ингестия
- **Цель**: Детекция моментных атак нот (`t_attack`, точность <= 15 мс) и их высоты (`pitch`) для генерации 4-дорожечного чарта.
- **Парадигма**: **Препроцессинг (Prefetching)** — полный анализ трека происходит ДО начала игры. Никакого стриминга во время геймплея.
- **Входные данные**: Поддержка файлов (`.mp3`, `.m4a`, `.opus`, `.flac`, `.wav`) и прямых ссылок YouTube (`yt-dlp` + `ffmpeg`).
- **Дискретизация**: Дискретизация $f_s = 22050$ Гц / $16000$ Гц ($f_{\text{max}} = 11025 / 8000$ Гц), покрывающая весь диапазон нот фортепиано (C8 = 4186 Гц).

---

## 2. Математическое ядро (DSP & Optimization)

### 2.1. Спектральный анализ (STFT & CQT)
- **STFT**: $X(m, k) = \sum_{n=0}^{N_{\text{fft}}-1} x[n + m H] \cdot w[n] \cdot e^{-j 2\pi \frac{k n}{N_{\text{fft}}}}$
- **CQT**: $f_k = f_0 \cdot 2^{k / b}$, где $f_0 \approx 32.7$ Гц (нота C1), $b = 12$ бинов на октаву.

### 2.2. Детекция атак (Onset Detection)
- **Spectral Flux**: $SF[m] = \sum_{k=0}^{K-1} \max\big(0, S(m, k) - S(m-1, k)\big)$ — прирост энергии.
- **Complex Domain Novelty**:
  - $R_{\text{pred}}(m, k) = R(m-1, k)$
  - $\phi_{\text{pred}}(m, k) = 2\phi(m-1, k) - \phi(m-2, k)$
  - $CD[m] = \sum_{k=0}^{K-1} \left| X(m, k) - X_{\text{pred}}(m, k) \right|$ — фазовые скачки.
- **Adaptive Peak Picking**: $\delta[m] = \mu[m] + \alpha \cdot \sigma[m] + \beta$.

### 2.3. Определение высоты тона (Pitch Estimation)
- **YIN (Моно)**: Нормализованная разность CMNDF $d_m'(\tau)$, $f_0 = f_s / T_0$.
- **HPS (Моно)**: $P(f) = \prod_{r=1}^{R} |X(r \cdot f)|$.
- **NMF (Полифония)**: Разложение $V \approx W \times H$ (матрица шаблонов $W$ и активаций $H$).
- **Spotify Basic-Pitch (Deep Learning)**: ONNX-модель, вероятности $P_{\text{onset}}(m, k)$ и $P_{\text{note}}(m, k)$.

### 2.4. Маппинг на 4 дорожки (Viterbi Dynamic Programming)
Минимизация стоимости для атак $(t_i, f_i)$ по дорожкам $l_i \in \{0, 1, 2, 3\}$:
$$\min_{\{l_i\}} \sum_{i=1}^{N} C_{\text{pitch}}(l_i, f_i) + \sum_{i=2}^{N} C_{\text{transition}}(l_i, l_{i-1}, \Delta t)$$
- $C_{\text{pitch}}$: Высокие ноты вправо, низкие влево.
- $C_{\text{transition}}$: $+\infty$ при $l_i = l_{i-1}$ и $\Delta t < 120$ мс (физический лимит повтора пальца).

---

## 3. Архитектура (Прототип vs Прод)

### 3.1. Тестовая архитектура (Прототип для R&D)
`Python DSP Engine` (Offline Pre-processing) -> `chart.json` -> `Local Web UI (Canvas 60fps + WebAudio)`

### 3.2. Прод-архитектура (Full Local Processing)
- **Only Java/Kotlin**: Desktop/Mobile приложение с Java ЦОС-ядром (`JTransforms`, `TarsosDSP`, `ONNX Runtime Java`).
- **Full Web/WASM**: Клиентский веб-сервис в браузерных Web Workers (`WebAudio API` + `WASM C++/Rust` / `ONNX Runtime Web`).
