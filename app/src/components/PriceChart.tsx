"use client";

import React, { useEffect, useRef, memo } from "react";
import { createChart, ColorType, CandlestickSeries } from "lightweight-charts";

export interface ChartCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

interface PriceChartProps {
  data: ChartCandle[];
  token: string;
  height?: number;
  pricePrefix?: string; // "$" or "" etc
}

function PriceChartInner({ data, token, height = 220, pricePrefix = "$" }: PriceChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ReturnType<typeof createChart> | null>(null);
  const seriesRef = useRef<any>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      height,
      layout: {
        background: { type: ColorType.Solid, color: "#12141c" },
        textColor: "#6b7280",
        fontSize: 10,
      },
      grid: {
        vertLines: { color: "#1e2030" },
        horzLines: { color: "#1e2030" },
      },
      crosshair: {
        vertLine: { color: "#22c55e40", width: 1, style: 3, labelBackgroundColor: "#22c55e" },
        horzLine: { color: "#22c55e40", width: 1, style: 3, labelBackgroundColor: "#22c55e" },
      },
      rightPriceScale: {
        borderColor: "#2a2d3a",
        scaleMargins: { top: 0.1, bottom: 0.1 },
      },
      timeScale: {
        borderColor: "#2a2d3a",
        timeVisible: true,
        secondsVisible: false,
      },
      handleScroll: { vertTouchDrag: false },
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor: "#22c55e",
      downColor: "#ef4444",
      borderDownColor: "#ef4444",
      borderUpColor: "#22c55e",
      wickDownColor: "#ef444480",
      wickUpColor: "#22c55e80",
    });

    chartRef.current = chart;
    seriesRef.current = series;

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        chart.applyOptions({ width: entry.contentRect.width });
      }
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, [height]);

  useEffect(() => {
    if (!seriesRef.current || data.length === 0) return;

    seriesRef.current.setData(data.map((c) => ({
      time: c.time,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    })));
    chartRef.current?.timeScale().scrollToRealTime();
  }, [data]);

  return <div ref={containerRef} className="w-full rounded-lg overflow-hidden" />;
}

export const PriceChart = memo(PriceChartInner);
