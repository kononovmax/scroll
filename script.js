/**
 * Интуитивный скролл «как в iOS» с:
 * - перетаскиванием содержимого (Drag),
 * - инерцией после отпускания (Decel),
 * - «резинкой»/возвратом к границам (Spring),
 * - состоянием покоя (Idle).
 *
 * Ключевые идеи:
 * 1) Во время перетаскивания (Drag) позиция контента сдвигается на dy от указателя.
 *    Если вышли за границы — движение ослабляется (rubber-band эффект).
 * 2) При отпускании вычисляется скорость из последних движений (estimateVelocity).
 *    Если в пределах — запускаем инерцию (Decel) с затуханием (FRICTION).
 *    Если вне границ — включаем пружину (Spring), которая возвращает к min/max.
 * 3) Рендер — через transform: translate3d(...) (GPU-friendly, без layout thrash).
 * 4) Ползунок (thumb) масштабируется по отношению vh/ch и синхронизируется с позицией.
 *
 * ВАЖНО:
 * - Если высота контента <= высоты вьюпорта, max=0 ⇒ скролла нет (об этом в updateThumb).
 * - MAX_VEL ограничивает стартовую скорость при отпускании.
 * - STOP_VEL — порог, ниже которого считаем инерцию завершённой (переход в Idle).
 * - SPRING_K — «жёсткость» пружины: чем больше, тем быстрее (и «жёстче») возврат.
 * - FRICTION — коэффициент затухания инерции (0.95 ≈ теряем 5% скорости за кадр).
 */

class CustomScroll {
	/**
	 * @param {HTMLElement} viewport - видимая область (контейнер со скрытым overflow).
	 * @param {HTMLElement} content  - прокручиваемое содержимое, которое будем переводить transform’ом.
	 * @param {HTMLElement} thumb    - ползунок кастомного скроллбара.
	 */
	constructor(viewport, content, thumb) {
		this.viewport = viewport;
		this.content = content;
		this.thumb = thumb;

		// --------- Геометрия и границы прокрутки ---------
		// Высота видимой области.
		this.vh = viewport.clientHeight;
		// Полная высота контента (включая невидимую часть).
		this.ch = content.scrollHeight;
		// Минимальное значение позиции (верхняя граница).
		this.min = 0;
		// Максимальная позиция (нижняя граница): контентная высота - высота окна.
		// Если контент короче окна — max=0, скролла по факту нет.
		this.max = Math.max(this.ch - this.vh, 0);

		// --------- Динамика состояния ---------
		// Текущая позиция «виртуального скролла» (в пикселях от верхней границы).
		this.pos = 0;
		// Текущая скорость (px/s) — положительная вниз, отрицательная вверх.
		this.vel = 0;

		// --------- Константы поведения ---------
		// FRICTION (0..1): множитель скорости на кадр в режиме инерции (Decel).
		// Пример: 0.95 — за кадр теряем 5% скорости ⇒ плавное замедление.
		this.FRICTION = 0.95;

		// SPRING_K: «жёсткость» пружины при возврате к границам (Spring).
		// Чем больше, тем быстрее возвращаемся (но и «резче»).
		this.SPRING_K = 0.15;

		// STOP_VEL: порог по модулю скорости (px/s), ниже которого инерцию считаем завершённой.
		this.STOP_VEL = 5;

		// MAX_VEL: ограничение стартовой скорости инерции (защита от «выстрелов»).
		this.MAX_VEL = 2000;

		// Целевая позиция для пружины (обычно 0 или this.max).
		this.springTarget = 0;

		// --------- Машина состояний ---------
		// Возможные состояния: "Drag" | "Decel" | "Spring" | "Idle"
		this.state = "Idle";

		// --------- Данные для pointer-сессии ---------
		this.pointerId = null; // захваченный pointer (для корректной обработки событий)
		this.lastY = 0; // последняя Y-позиция указателя
		this.lastMoveTime = 0; // время последнего движения (ms, performance.now())
		this.moveHistory = []; // последние 4–5 движений (dy, dt) для оценки скорости

		this.bindEvents();
		this.animate(); // запускаем бесконечный цикл рендера
	}

	bindEvents() {
		// Начало перетаскивания: захватываем pointer, обнуляем инерцию и историю.
		this.viewport.addEventListener("pointerdown", (e) => {
			this.pointerId = e.pointerId;
			this.viewport.setPointerCapture(this.pointerId);

			this.state = "Drag"; // переходим в режим перетаскивания
			this.vel = 0; // инерцию сбрасываем — теперь управляет пользователь
			this.lastY = e.clientY;
			this.lastMoveTime = performance.now();
			this.moveHistory = []; // история для estimateVelocity после отпускания

			this.viewport.classList.add("active"); // (опционально) стили на время drag
		});

		// Перетаскивание: обновляем позицию (pos) и записываем микродвижения в историю.
		this.viewport.addEventListener("pointermove", (e) => {
			if (this.state !== "Drag") return;

			const dy = e.clientY - this.lastY; // сдвиг указателя по Y
			this.lastY = e.clientY;

			// Если вышли за пределы (pos < min или pos > max) — ослабляем движение,
			// создавая эффект «резинки»: чем дальше за границей, тем сильнее сопротивление.
			if (this.pos < this.min || this.pos > this.max) {
				this.pos += dy * 0.4; // 0.4 — эмпирический коэффициент ослабления
			} else {
				this.pos += dy; // в пределах — один к одному
			}

			// Копим небольшую историю (последние ~5 движений) для оценки скорости:
			// скорость = сумма dy / сумма dt (пересчитанная в px/сек).
			const now = performance.now();
			this.moveHistory.push({
				dy,
				dt: now - this.lastMoveTime,
			});
			if (this.moveHistory.length > 5) this.moveHistory.shift();
			this.lastMoveTime = now;
		});

		// Конец перетаскивания: отпускаем pointer и выбираем следующий режим:
		// - если вне границ ⇒ Spring (возврат к min или max),
		// - если скорость заметная ⇒ Decel (инерция),
		// - иначе ⇒ Idle (покой).
		this.viewport.addEventListener("pointerup", (e) => {
			// Снимаем захват pointer (важно для корректной работы на тач/стилус).
			if (this.pointerId != null) {
				this.viewport.releasePointerCapture(this.pointerId);
				this.pointerId = null;
			}
			this.viewport.classList.remove("active");

			// Оценим финальную скорость по последним движениям.
			const velocity = this.estimateVelocity();

			// Если «вылетели» за границы — сразу тянем назад пружиной.
			if (this.pos < this.min || this.pos > this.max) {
				this.springTarget = this.pos < this.min ? this.min : this.max;
				this.state = "Spring";
			}
			// Если скорость заметная — запускаем инерцию (с ограничением MAX_VEL).
			else if (Math.abs(velocity) > this.STOP_VEL) {
				this.vel = Math.max(
					Math.min(velocity, this.MAX_VEL),
					-this.MAX_VEL
				);
				this.state = "Decel";
			}
			// Иначе — останавливаемся.
			else {
				this.state = "Idle";
			}
		});

		// (Опционально для полноты) Можно добавить обработку pointercancel,
		// а также обработку ресайза окна (пересчитать vh/ch/max).
	}

	/**
	 * Оценка скорости (px/s) по истории последних движений.
	 * Берём сумму dy и сумму dt, переводим в «в секунду».
	 */
	estimateVelocity() {
		let totalDy = 0,
			totalDt = 0;
		for (const m of this.moveHistory) {
			totalDy += m.dy;
			totalDt += m.dt;
		}
		// Если dt > 0 ⇒ скорость = (px / ms) * 1000 = px/s
		return totalDt > 0 ? (totalDy / totalDt) * 1000 : 0;
	}

	/**
	 * Главный «игровой цикл» — вызывается каждый кадр.
	 * В зависимости от state меняем pos/vel и отрисовываем контент и ползунок.
	 */
	animate() {
		// Рекурсивный вызов через requestAnimationFrame (60fps где возможно).
		requestAnimationFrame(() => this.animate());

		// Состояние инерции: pos меняется на vel*dt, скорость затухает через FRICTION.
		if (this.state === "Decel") {
			// Простейшая аппроксимация dt ≈ 1/60 c (можно считать реальный dt, если нужно точнее).
			this.pos += this.vel * (1 / 60);
			this.vel *= this.FRICTION;

			// Когда скорость падает ниже порога — считаем, что «остановились».
			if (Math.abs(this.vel) < this.STOP_VEL) this.state = "Idle";

			// Если во время инерции вылетели за границы — переключаемся в Spring.
			if (this.pos < this.min || this.pos > this.max) {
				this.springTarget = this.pos < this.min ? this.min : this.max;
				this.state = "Spring";
			}
		}
		// Состояние пружины: тянем pos к springTarget по закону «пружины» (Hooke).
		else if (this.state === "Spring") {
			const delta = this.springTarget - this.pos; // «насколько мы смещены» от цели
			this.vel = delta * this.SPRING_K; // скорость пропорциональна смещению
			this.pos += this.vel; // двигаем позицию в сторону цели

			// Когда достаточно близко к цели — щёлкаем ровно в неё и завершаем.
			if (Math.abs(delta) < 0.5) {
				this.pos = this.springTarget;
				this.state = "Idle";
			}
		}

		// --------- Рендер контента и ползунка ---------
		// Переводим содержимое на -pos (если pos растёт вниз, визуально контент «уходит вверх»).
		// translate3d задействует GPU, помогает избежать лишних reflow.
		this.content.style.transform = `translate3d(0,${-Math.round(
			this.pos
		)}px,0)`;

		// Обновляем положение и размер ползунка кастомного скролла.
		this.updateThumb();
	}

	/**
	 * Синхронизация кастомного «ползунка» с текущей прокруткой.
	 * - Высота ползунка пропорциональна отношению видимой области к полной высоте контента.
	 * - Положение ползунка пропорционально scrollRatio = pos / max.
	 */
	updateThumb() {
		// Доля видимой области от контента.
		const ratio = this.vh / this.ch;

		// Минимальная высота ползунка 20px, чтобы он не «исчезал».
		const thumbHeight = Math.max(this.vh * ratio, 20);
		this.thumb.style.height = `${thumbHeight}px`;

		// Максимальный сдвиг ползунка вниз (в пределах рейлера).
		const maxThumbY = this.vh - thumbHeight;

		// Отношение текущей позиции к максимально возможной.
		// NB: если this.max === 0 (контент короче или равен окну) ⇒ деление на 0.
		// В текущей версии это даст Infinity/NaN в style.transform — визуально лучше зафиксировать 0.
		const scrollRatio = this.max > 0 ? this.pos / this.max : 0;

		this.thumb.style.transform = `translateY(${maxThumbY * scrollRatio}px)`;
	}
}

// Инициализация: передаём элементы вьюпорта, контента и ползунка.
// Предполагается, что CSS скрывает нативный скроллбар и оформляет .thumb поверх.
new CustomScroll(
	document.querySelector(".viewport"),
	document.querySelector(".content"),
	document.querySelector(".thumb")
);
