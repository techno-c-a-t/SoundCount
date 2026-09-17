# TASKS: Текущий статус и Активные задачи

## 📌 Текущий статус
- **Текущий этап**: Подготовка к разработке Спринта 1 (DSP Onset Baseline).
- **Фокус MVP**: Работа только с локальными `.mp3` и `.m4a` файлами на стандартной частоте `22050 Гц` (Librosa default).
- **Будущие фичи**: Вынесены в [IDEAS.md](file:///home/technocat/Документы/Projects/SoundCount/IDEAS.md).

---

## 📋 Спринт 1: Ингестия (.mp3/.m4a) и Детекция атак (Onset Detection)

### В процессе
- [ ] Настройка окружения Python (`scipy`, `numpy`, `librosa`, `soundfile`).

### К выполнению
- [ ] **Task 1.1**: Модуль `ingest.py` — загрузка локального `.mp3` / `.m4a` файла и конвертация в 22050 Гц моно `.wav`.
- [ ] **Task 1.2**: Модуль `onset_spectral_flux.py` — вычисление CQT/STFT и расчёт функции новизны Spectral Flux `SF[m]`.
- [ ] **Task 1.3**: Модуль `onset_complex.py` — детекция фазовых отклонений Complex Domain Novelty `CD[m]`.
- [ ] **Task 1.4**: Модуль `peak_picker.py` — адаптивный порог `δ[m] = μ[m] + α*σ[m] + β` и извлечение временных меток атак `T_attacks`.
- [ ] **Task 1.5**: Визуализация — построение графиков спектрограммы и меток атак для проверки точности.

---

## 📈 Бэклог следующих этапов

- [ ] **Pitch Extractor (YIN / Basic-Pitch)**
- [ ] **Viterbi Lane Mapper (4-lane DP)**
- [ ] **Web GUI Client (HTML5 Canvas + WebAudio)**
