import React, { useState, useEffect, useMemo, useRef } from 'react';
import { List } from 'react-window';
import IntelligenceCard from './IntelligenceCard';

const VirtualMatchGrid = ({ matches, onOpenUltimate }) => {
    const containerRef = useRef(null);
    const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });

    // 📏 Track container dimensions for virtualization
    useEffect(() => {
        if (!containerRef.current) return;

        const observer = new ResizeObserver((entries) => {
            for (let entry of entries) {
                setContainerSize({
                    width: entry.contentRect.width,
                    height: entry.contentRect.height
                });
            }
        });

        observer.observe(containerRef.current);
        setContainerSize({
            width: containerRef.current.offsetWidth,
            height: containerRef.current.offsetHeight
        });

        return () => observer.disconnect();
    }, []);

    // 🧠 Grid Logic: Calculate number of columns
    const gridConfig = useMemo(() => {
        const minColumnWidth = 380;
        const gap = 30;
        
        // Calculate columns: (Width + gap) / (minWidth + gap)
        let columns = Math.floor((containerSize.width + gap) / (minColumnWidth + gap));
        columns = Math.max(1, columns); // At least 1 column
        
        const rowHeight = 480; // Buffer for scale hover effect
        
        // Group matches into rows
        const rows = [];
        for (let i = 0; i < matches.length; i += columns) {
            rows.push(matches.slice(i, i + columns));
        }

        return { columns, rows, rowHeight };
    }, [containerSize.width, matches]);

    // 🎨 Row Renderer: Draws 1 row with 'columns' cards
    const Row = useMemo(() => {
        return ({ index, style }) => {
            const rowMatches = gridConfig.rows[index];
            if (!rowMatches) return null;

            return (
                <div style={{ 
                    ...style, 
                    display: 'grid', 
                    gridTemplateColumns: `repeat(${gridConfig.columns}, 1fr)`,
                    gap: '30px',
                    paddingBottom: '30px',
                    width: '100%',
                    paddingRight: '10px' // Prevent card overlap with scrollbar
                }}>
                    {rowMatches.map((match) => (
                        <IntelligenceCard 
                            key={match.id} 
                            match={match} 
                            onOpenUltimate={() => onOpenUltimate(match)} 
                            style={{ height: '100%' }}
                        />
                    ))}
                </div>
            );
        };
    }, [gridConfig.rows, gridConfig.columns, onOpenUltimate]);

    const RowMemo = React.memo(Row);

    return (
        <div ref={containerRef} className="virtual-grid-wrapper" style={{ width: '100%', height: '100%', position: 'relative' }}>
            {containerSize.width > 0 && containerSize.height > 0 && (
                <List
                    height={containerSize.height}
                    rowCount={gridConfig.rows.length}
                    rowHeight={gridConfig.rowHeight}
                    width={containerSize.width}
                    className="titanium-virtual-list"
                    style={{ overflowX: 'hidden' }}
                    rowComponent={RowMemo}
                    rowProps={{}} 
                />
            )}
        </div>
    );
};


export default VirtualMatchGrid;
