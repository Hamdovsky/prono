"""
Benchmark script to measure RAM usage and performance
Compares old vs new model loading system
"""
import os
import sys
import time
import json
import psutil
from pathlib import Path

# Add core to path
sys.path.insert(0, str(Path(__file__).parent.parent / 'core'))

def get_memory_usage():
    """Get current process memory usage in MB"""
    process = psutil.Process(os.getpid())
    mem_info = process.memory_info()
    return mem_info.rss / (1024 * 1024)  # Convert to MB

def benchmark_old_system():
    """Benchmark old model loading system"""
    print("\n" + "="*60)
    print("BENCHMARK: Old System (load all models)")
    print("="*60)
    
    # Reset environment
    os.environ['USE_MODEL_MANAGER'] = 'false'
    
    # Clear any imports
    if 'prediction_engine' in sys.modules:
        del sys.modules['prediction_engine']
    
    mem_before = get_memory_usage()
    print(f"Memory before: {mem_before:.2f} MB")
    
    start_time = time.time()
    
    try:
        from prediction_engine import (
            get_v55_booster,
            get_titanium_booster,
            get_titanium_v4_booster
        )
        
        # Load models (simulates T1 prediction)
        v55 = get_v55_booster()
        v24 = get_titanium_booster()
        v4 = get_titanium_v4_booster()
        
        load_time = time.time() - start_time
        mem_after = get_memory_usage()
        mem_delta = mem_after - mem_before
        
        models_loaded = sum([v55 is not None, v24 is not None, v4 is not None])
        
        print(f"✅ Models loaded: {models_loaded}/3")
        print(f"⏱️  Load time: {load_time:.3f}s")
        print(f"💾 Memory after: {mem_after:.2f} MB")
        print(f"📊 Memory delta: {mem_delta:.2f} MB")
        
        return {
            'system': 'old',
            'models_loaded': models_loaded,
            'load_time': load_time,
            'memory_before': mem_before,
            'memory_after': mem_after,
            'memory_delta': mem_delta
        }
        
    except Exception as e:
        print(f"❌ Error: {e}")
        return None

def benchmark_new_system():
    """Benchmark new model_manager system"""
    print("\n" + "="*60)
    print("BENCHMARK: New System (model_manager)")
    print("="*60)
    
    # Enable model_manager
    os.environ['USE_MODEL_MANAGER'] = 'true'
    
    # Clear any imports
    for mod in ['model_manager', 'model_loader']:
        if mod in sys.modules:
            del sys.modules[mod]
    
    mem_before = get_memory_usage()
    print(f"Memory before: {mem_before:.2f} MB")
    
    start_time = time.time()
    
    try:
        from model_manager import get_model_manager
        
        manager = get_model_manager()
        
        # Load only required models for T1 (v55 + v24)
        models = manager.get_required_models('T1', is_wc2026=False)
        
        load_time = time.time() - start_time
        mem_after = get_memory_usage()
        mem_delta = mem_after - mem_before
        
        models_loaded = len(models)
        
        print(f"✅ Models loaded: {models_loaded}")
        print(f"📦 Loaded: {list(models.keys())}")
        print(f"⏱️  Load time: {load_time:.3f}s")
        print(f"💾 Memory after: {mem_after:.2f} MB")
        print(f"📊 Memory delta: {mem_delta:.2f} MB")
        
        # Cache stats
        stats = manager.get_cache_stats()
        print(f"🗃️  Cache: {stats['count']} models in memory")
        
        return {
            'system': 'new',
            'models_loaded': models_loaded,
            'load_time': load_time,
            'memory_before': mem_before,
            'memory_after': mem_after,
            'memory_delta': mem_delta,
            'cache_stats': stats
        }
        
    except Exception as e:
        print(f"❌ Error: {e}")
        import traceback
        traceback.print_exc()
        return None

def benchmark_t3_league():
    """Benchmark T3 league (should only load v55)"""
    print("\n" + "="*60)
    print("BENCHMARK: T3 League (model_manager)")
    print("="*60)
    
    os.environ['USE_MODEL_MANAGER'] = 'true'
    
    mem_before = get_memory_usage()
    print(f"Memory before: {mem_before:.2f} MB")
    
    start_time = time.time()
    
    try:
        from model_manager import get_model_manager
        
        manager = get_model_manager()
        manager.clear_cache()  # Start fresh
        
        # Load only for T3
        models = manager.get_required_models('T3', is_wc2026=False)
        
        load_time = time.time() - start_time
        mem_after = get_memory_usage()
        mem_delta = mem_after - mem_before
        
        models_loaded = len(models)
        
        print(f"✅ Models loaded: {models_loaded}")
        print(f"📦 Loaded: {list(models.keys())}")
        print(f"⏱️  Load time: {load_time:.3f}s")
        print(f"💾 Memory after: {mem_after:.2f} MB")
        print(f"📊 Memory delta: {mem_delta:.2f} MB")
        
        return {
            'system': 'new_t3',
            'models_loaded': models_loaded,
            'load_time': load_time,
            'memory_before': mem_before,
            'memory_after': mem_after,
            'memory_delta': mem_delta
        }
        
    except Exception as e:
        print(f"❌ Error: {e}")
        import traceback
        traceback.print_exc()
        return None

def compare_results(old_result, new_result, t3_result):
    """Compare benchmark results"""
    print("\n" + "="*60)
    print("COMPARISON RESULTS")
    print("="*60)
    
    if not old_result or not new_result:
        print("⚠️ Cannot compare - missing results")
        return
    
    # Memory comparison
    old_mem = old_result['memory_delta']
    new_mem = new_result['memory_delta']
    t3_mem = t3_result['memory_delta'] if t3_result else 0
    
    mem_saved = old_mem - new_mem
    mem_saved_pct = (mem_saved / old_mem * 100) if old_mem > 0 else 0
    
    t3_mem_saved = old_mem - t3_mem
    t3_mem_saved_pct = (t3_mem_saved / old_mem * 100) if old_mem > 0 else 0
    
    print(f"\n📊 MEMORY USAGE")
    print(f"Old system:     {old_mem:.2f} MB")
    print(f"New system (T1): {new_mem:.2f} MB")
    if t3_result:
        print(f"New system (T3): {t3_mem:.2f} MB")
    print(f"\n💾 SAVINGS")
    print(f"T1 saved:       {mem_saved:.2f} MB ({mem_saved_pct:.1f}%)")
    if t3_result:
        print(f"T3 saved:       {t3_mem_saved:.2f} MB ({t3_mem_saved_pct:.1f}%)")
    
    # Time comparison
    old_time = old_result['load_time']
    new_time = new_result['load_time']
    
    time_diff = new_time - old_time
    time_diff_pct = (time_diff / old_time * 100) if old_time > 0 else 0
    
    print(f"\n⏱️  LOAD TIME")
    print(f"Old system:     {old_time:.3f}s")
    print(f"New system:     {new_time:.3f}s")
    print(f"Difference:     {time_diff:+.3f}s ({time_diff_pct:+.1f}%)")
    
    # Summary
    print(f"\n🎯 SUMMARY")
    if mem_saved > 0:
        print(f"✅ Memory optimization: {mem_saved:.2f} MB saved ({mem_saved_pct:.1f}%)")
    else:
        print(f"⚠️ Memory optimization: No savings")
    
    if time_diff < 0:
        print(f"✅ Speed improvement: {abs(time_diff):.3f}s faster")
    elif time_diff < 0.1:
        print(f"✅ Speed: Equivalent (±0.1s)")
    else:
        print(f"⚠️ Speed: {time_diff:.3f}s slower")
    
    # Save results to JSON
    results = {
        'timestamp': time.time(),
        'old_system': old_result,
        'new_system': new_result,
        't3_system': t3_result,
        'comparison': {
            'memory_saved_mb': mem_saved,
            'memory_saved_pct': mem_saved_pct,
            't3_memory_saved_mb': t3_mem_saved,
            't3_memory_saved_pct': t3_mem_saved_pct,
            'time_diff_s': time_diff,
            'time_diff_pct': time_diff_pct
        }
    }
    
    output_file = 'benchmark_results.json'
    with open(output_file, 'w') as f:
        json.dump(results, f, indent=2)
    
    print(f"\n📄 Results saved to: {output_file}")

def main():
    print("\n🚀 MODEL LOADING BENCHMARK")
    print("=" * 60)
    print("Comparing old vs new model loading systems")
    print("=" * 60)
    
    # Check if psutil is available
    try:
        import psutil
    except ImportError:
        print("❌ Error: psutil not installed")
        print("Install with: pip install psutil")
        return
    
    # Run benchmarks
    old_result = benchmark_old_system()
    time.sleep(2)  # Cool down
    
    new_result = benchmark_new_system()
    time.sleep(2)  # Cool down
    
    t3_result = benchmark_t3_league()
    
    # Compare
    compare_results(old_result, new_result, t3_result)
    
    print("\n✅ Benchmark complete!")

if __name__ == '__main__':
    main()
