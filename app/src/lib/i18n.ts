export type Lang = "en" | "ru";

const translations = {
  // Header
  "app.title": { en: "AI Asset Manager", ru: "AI Менеджер Активов" },
  "app.subtitle": { en: "Autonomous trading agent on Solana", ru: "Автономный торговый агент на Solana" },
  "app.demo": { en: "demo", ru: "демо" },

  // Strategy screen
  "strategy.title": { en: "Create Agent", ru: "Создать агента" },
  "strategy.desc": { en: "Pick a risk level for your trading agent", ru: "Выбери уровень риска для торгового агента" },
  "strategy.conservative": { en: "Conservative", ru: "Консервативный" },
  "strategy.moderate": { en: "Moderate", ru: "Умеренный" },
  "strategy.aggressive": { en: "Aggressive", ru: "Агрессивный" },
  "strategy.conservative.desc": { en: "Low risk, small trades", ru: "Низкий риск, мелкие сделки" },
  "strategy.moderate.desc": { en: "Balanced approach", ru: "Сбалансированный подход" },
  "strategy.aggressive.desc": { en: "High risk, big moves", ru: "Высокий риск, крупные сделки" },
  "strategy.create": { en: "Create Agent", ru: "Создать агента" },
  "strategy.creating": { en: "Creating...", ru: "Создание..." },

  // Features
  "feature.ai": { en: "AI Decisions", ru: "Решения ИИ" },
  "feature.ai.desc": { en: "Market analysis & auto-trading", ru: "Анализ рынка и авто-торговля" },
  "feature.chain": { en: "On-Chain", ru: "Блокчейн" },
  "feature.chain.desc": { en: "Trades on Solana blockchain", ru: "Сделки в блокчейне Solana" },
  "feature.control": { en: "Full Control", ru: "Полный контроль" },
  "feature.control.desc": { en: "Deposit & withdraw anytime", ru: "Ввод и вывод в любое время" },

  // Dashboard
  "dash.balance": { en: "Agent Balance", ru: "Баланс агента" },
  "dash.wallet": { en: "Wallet", ru: "Кошелёк" },
  "dash.deposit": { en: "Deposit", ru: "Пополнить" },
  "dash.withdraw": { en: "Withdraw", ru: "Вывести" },
  "dash.positions": { en: "Open Positions", ru: "Открытые позиции" },
  "dash.no_positions": { en: "No positions yet", ru: "Позиций пока нет" },
  "dash.lamports": { en: "lamports", ru: "лампортов" },

  // AI Engine
  "ai.engine": { en: "AI Engine", ru: "Движок ИИ" },
  "ai.run": { en: "Run AI", ru: "Запустить ИИ" },
  "ai.auto": { en: "Auto", ru: "Авто" },
  "ai.stop": { en: "Stop", ru: "Стоп" },
  "ai.need_deposit": { en: "Deposit SOL first to run AI", ru: "Сначала пополни баланс" },

  // Market
  "market.title": { en: "Market", ru: "Рынок" },
  "market.mock": { en: "simulated", ru: "симуляция" },

  // History
  "history.title": { en: "Trade History", ru: "История сделок" },
  "history.empty": { en: "No trades yet", ru: "Сделок пока нет" },
  "history.total": { en: "Total trades", ru: "Всего сделок" },
  "history.buys": { en: "buys", ru: "покупок" },
  "history.sells": { en: "sells", ru: "продаж" },
  "history.holds": { en: "holds", ru: "ожиданий" },
  "history.amount": { en: "Amount", ru: "Сумма" },
  "history.price": { en: "Price", ru: "Цена" },
  "history.change": { en: "Change", ru: "Изменение" },
  "history.volume": { en: "Volume traded", ru: "Объём сделок" },

  // AI Log
  "log.title": { en: "AI Log", ru: "Лог ИИ" },
  "log.entries": { en: "entries", ru: "записей" },
  "log.empty": { en: "Press \"Run AI\" to start", ru: "Нажми \"Запустить ИИ\"" },
  "log.details": { en: "Details", ru: "Подробнее" },
  "log.what_happened": { en: "What happened", ru: "Что произошло" },
  "log.why": { en: "Why", ru: "Почему" },
  "log.confidence": { en: "AI Confidence", ru: "Уверенность ИИ" },
  "log.asset": { en: "Asset", ru: "Актив" },
  "log.price_now": { en: "Current price", ru: "Текущая цена" },
  "log.price_change": { en: "Price change", ru: "Изменение цены" },
  "log.trade_amount": { en: "Trade amount", ru: "Сумма сделки" },
  "log.summary_buy": { en: "AI bought", ru: "ИИ купил" },
  "log.summary_sell": { en: "AI sold", ru: "ИИ продал" },
  "log.summary_hold": { en: "AI is waiting", ru: "ИИ ждёт" },
  "log.summary_buy_reason": { en: "Price going up — good time to buy", ru: "Цена растёт — хороший момент для покупки" },
  "log.summary_sell_reason": { en: "Price going down — selling to protect funds", ru: "Цена падает — продаём чтобы защитить средства" },
  "log.summary_hold_reason": { en: "No clear trend — waiting for a better moment", ru: "Нет чёткого тренда — ждём лучший момент" },
  "log.conf_high": { en: "High — AI is very sure", ru: "Высокая — ИИ уверен" },
  "log.conf_medium": { en: "Medium — AI is somewhat sure", ru: "Средняя — ИИ частично уверен" },
  "log.conf_low": { en: "Low — AI is uncertain", ru: "Низкая — ИИ не уверен" },

  // Actions
  "action.buy": { en: "BUY", ru: "ПОКУПКА" },
  "action.sell": { en: "SELL", ru: "ПРОДАЖА" },
  "action.hold": { en: "HOLD", ru: "ОЖИДАНИЕ" },

  // Market categories
  "market.select": { en: "Market to analyze", ru: "Рынок для анализа" },
  "market.crypto": { en: "Crypto", ru: "Крипта" },
  "market.realestate": { en: "Real Estate", ru: "Недвижимость" },
  "market.stocks": { en: "Stocks", ru: "Акции" },
  "market.commodities": { en: "Commodities", ru: "Сырьё" },

  // Real data labels
  "data.live_badge": { en: "Live Data", ru: "Реальные данные" },
  "data.live_coingecko": { en: "Real Data • CoinGecko API", ru: "Реальные данные • CoinGecko API" },
  "data.live_prices": { en: "Live prices", ru: "Реальные цены" },
  "data.no_data": { en: "No data", ru: "Нет данных" },

  // Portfolio
  "dash.portfolio": { en: "Portfolio", ru: "Портфель" },
  "dash.in_positions": { en: "In positions", ru: "В позициях" },

  // Chart
  "chart.title": { en: "Chart", ru: "График" },

  // Technical analysis
  "feature.ta": { en: "Tech Analysis", ru: "Тех. анализ" },
  "feature.ta.desc": { en: "RSI, MACD, Bollinger", ru: "RSI, MACD, Боллинджер" },
  "ta.indicators": { en: "RSI • MACD • Bollinger • ADX • Stochastic", ru: "RSI • MACD • Bollinger • ADX • Stochastic" },
  "ta.trend": { en: "Trend", ru: "Тренд" },
  "ta.signals": { en: "Signals", ru: "Сигналы" },
  "ta.reasoning": { en: "Reasoning", ru: "Обоснование" },

  // System messages
  "sys.agent_created": { en: "Agent created! Strategy:", ru: "Агент создан! Стратегия:" },
  "sys.deposited": { en: "Deposited", ru: "Пополнено" },
  "sys.withdrew": { en: "Withdrew", ru: "Выведено" },
  "sys.invalid_deposit": { en: "Invalid amount or insufficient balance", ru: "Неверная сумма или недостаточно средств" },
  "sys.invalid_withdraw": { en: "Invalid amount or insufficient agent balance", ru: "Неверная сумма или недостаточно на балансе агента" },
  "sys.market_switched": { en: "Switched market to", ru: "Рынок переключён на" },

  // Jupiter DEX
  "jupiter.title": { en: "Jupiter DEX", ru: "Jupiter DEX" },
  "jupiter.settings": { en: "Swap Settings", ru: "Настройки свопов" },
  "jupiter.slippage": { en: "Slippage", ru: "Проскальзывание" },
  "jupiter.max_impact": { en: "Max Price Impact", ru: "Макс. влияние на цену" },
  "jupiter.max_trade": { en: "Max Trade Size", ru: "Макс. размер сделки" },
  "jupiter.real_swaps": { en: "Real Swaps", ru: "Реальные свопы" },
  "jupiter.simulation": { en: "Simulation Mode", ru: "Режим симуляции" },
  "jupiter.sim_desc": { en: "AI trades are simulated. Enable real swaps to trade with actual funds.", ru: "Сделки ИИ симулируются. Включи реальные свопы для торговли настоящими средствами." },
  "jupiter.real_desc": { en: "⚠ REAL MONEY: AI will swap real tokens via Jupiter DEX", ru: "⚠ РЕАЛЬНЫЕ ДЕНЬГИ: ИИ будет менять реальные токены через Jupiter DEX" },
  "jupiter.enable": { en: "Enable Real Trading", ru: "Включить реальную торговлю" },
  "jupiter.disable": { en: "Switch to Simulation", ru: "Переключить на симуляцию" },
  "jupiter.confirm_title": { en: "Confirm Real Trade", ru: "Подтверди реальную сделку" },
  "jupiter.confirm_desc": { en: "This will swap real tokens in your wallet", ru: "Это обменяет реальные токены в твоём кошельке" },
  "jupiter.confirm_yes": { en: "Confirm Swap", ru: "Подтвердить своп" },
  "jupiter.confirm_no": { en: "Cancel", ru: "Отмена" },
  "jupiter.swap_success": { en: "Swap executed", ru: "Своп выполнен" },
  "jupiter.swap_failed": { en: "Swap failed", ru: "Своп не удался" },
  "jupiter.price_impact": { en: "Price Impact", ru: "Влияние на цену" },
  "jupiter.route": { en: "Route", ru: "Маршрут" },
  "jupiter.balances": { en: "Token Balances", ru: "Балансы токенов" },
  "jupiter.no_wallet": { en: "Connect wallet to see balances", ru: "Подключи кошелёк для просмотра балансов" },

  // Backtesting
  "bt.title": { en: "Backtesting", ru: "Бэктестинг" },
  "bt.run": { en: "Run Backtest", ru: "Запустить бэктест" },
  "bt.running": { en: "Running...", ru: "Выполняется..." },
  "bt.period": { en: "Period", ru: "Период" },
  "bt.days": { en: "days", ru: "дней" },
  "bt.capital": { en: "Initial Capital", ru: "Начальный капитал" },
  "bt.strategy_label": { en: "Strategy", ru: "Стратегия" },
  "bt.results": { en: "Results", ru: "Результаты" },
  "bt.total_return": { en: "Total Return", ru: "Общая доходность" },
  "bt.annual_return": { en: "Annualized", ru: "Годовая" },
  "bt.max_drawdown": { en: "Max Drawdown", ru: "Макс. просадка" },
  "bt.sharpe": { en: "Sharpe Ratio", ru: "Коэфф. Шарпа" },
  "bt.sortino": { en: "Sortino Ratio", ru: "Коэфф. Сортино" },
  "bt.win_rate": { en: "Win Rate", ru: "% побед" },
  "bt.total_trades": { en: "Total Trades", ru: "Всего сделок" },
  "bt.winning": { en: "Winning", ru: "Прибыльных" },
  "bt.losing": { en: "Losing", ru: "Убыточных" },
  "bt.profit_factor": { en: "Profit Factor", ru: "Профит-фактор" },
  "bt.avg_win": { en: "Avg Win", ru: "Средний выигрыш" },
  "bt.avg_loss": { en: "Avg Loss", ru: "Средний убыток" },
  "bt.best_trade": { en: "Best Trade", ru: "Лучшая сделка" },
  "bt.worst_trade": { en: "Worst Trade", ru: "Худшая сделка" },
  "bt.volatility": { en: "Volatility", ru: "Волатильность" },
  "bt.equity_curve": { en: "Equity Curve", ru: "Кривая капитала" },
  "bt.trade_log": { en: "Trade Log", ru: "Лог сделок" },
  "bt.loading_data": { en: "Loading historical data...", ru: "Загрузка исторических данных..." },
  "bt.no_data": { en: "No results yet. Run a backtest to see performance.", ru: "Нет результатов. Запусти бэктест, чтобы увидеть результаты." },
  "bt.final_capital": { en: "Final Capital", ru: "Итоговый капитал" },
  "bt.duration": { en: "Duration", ru: "Длительность" },
  "bt.avg_hold": { en: "Avg Hold Time", ru: "Среднее время удержания" },
  "bt.hours": { en: "hours", ru: "часов" },

  // P&L Tracker
  "pnl.title": { en: "Performance", ru: "Результативность" },
  "pnl.total": { en: "Total P&L", ru: "Общий P&L" },
  "pnl.realized": { en: "Realized", ru: "Реализованный" },
  "pnl.unrealized": { en: "Unrealized", ru: "Нереализованный" },
  "pnl.win_rate": { en: "Win Rate", ru: "% побед" },
  "pnl.trades": { en: "Trades", ru: "Сделок" },
  "pnl.sharpe": { en: "Sharpe", ru: "Шарп" },
  "pnl.drawdown": { en: "Drawdown", ru: "Просадка" },
  "pnl.current_dd": { en: "Current DD", ru: "Текущая просадка" },
  "pnl.max_dd": { en: "Max DD", ru: "Макс. просадка" },
  "pnl.profit_factor": { en: "Profit Factor", ru: "Профит-фактор" },
  "pnl.expectancy": { en: "Expectancy", ru: "Ожидание" },
  "pnl.per_trade": { en: "per trade", ru: "за сделку" },
  "pnl.streak": { en: "Streak", ru: "Серия" },
  "pnl.wins": { en: "W", ru: "П" },
  "pnl.losses": { en: "L", ru: "У" },
  "pnl.best": { en: "Best", ru: "Лучшая" },
  "pnl.worst": { en: "Худшая", ru: "Худшая" },
  "pnl.equity": { en: "Equity", ru: "Капитал" },
  "pnl.peak": { en: "Peak", ru: "Пик" },
  "pnl.cash_pct": { en: "Cash", ru: "Кэш" },
  "pnl.pos_pct": { en: "Positions", ru: "Позиции" },
  "pnl.no_trades": { en: "No completed trades yet", ru: "Завершённых сделок пока нет" },
  "pnl.calmar": { en: "Calmar", ru: "Калмар" },
  "pnl.volatility": { en: "Volatility", ru: "Волатильность" },
  "pnl.closed_trades": { en: "Closed Trades", ru: "Закрытые сделки" },
} as const;

type TranslationKey = keyof typeof translations;

export function t(key: TranslationKey, lang: Lang): string {
  return translations[key]?.[lang] ?? key;
}

export function getStrategyName(index: number, lang: Lang): string {
  const keys: TranslationKey[] = ["strategy.conservative", "strategy.moderate", "strategy.aggressive"];
  return t(keys[index] || keys[1], lang);
}

export function getActionName(action: string, lang: Lang): string {
  const map: Record<string, TranslationKey> = {
    BUY: "action.buy",
    SELL: "action.sell",
    HOLD: "action.hold",
  };
  return t(map[action] || "action.hold", lang);
}

export function getMarketCategoryName(cat: string, lang: Lang): string {
  const map: Record<string, TranslationKey> = {
    crypto: "market.crypto",
    realestate: "market.realestate",
    stocks: "market.stocks",
    commodities: "market.commodities",
  };
  return t(map[cat] || "market.crypto", lang);
}
